#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import html
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

from seleniumbase import SB


BASE_URL = "https://control.gaming4free.net"
MAX_SECONDS = 72 * 60 * 60
EXTEND_SECONDS = 90 * 60
COOLDOWN_SECONDS = 10 * 60
SAFE_RENEW_THRESHOLD = MAX_SECONDS - EXTEND_SECONDS
ARTIFACT_DIR = Path("artifacts")
SCREENSHOT_PATH = ARTIFACT_DIR / "renew-page.png"
LOG_PATH = ARTIFACT_DIR / "run.log"

LOGS = []


def log(message):
    line = f"[{datetime.utcnow().isoformat(timespec='milliseconds')}Z] {message}"
    LOGS.append(line)
    print(line, flush=True)


def require_env(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def optional_env(name, fallback=""):
    return os.environ.get(name, "").strip() or fallback


def ensure_artifacts():
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)


def persist_logs():
    ensure_artifacts()
    LOG_PATH.write_text("\n".join(LOGS) + "\n", encoding="utf-8")


def build_server_url(server_id):
    return f"{BASE_URL}/server/{server_id}/public-renewing"


def resolve_server_url():
    explicit = optional_env("GFE_SERVER_URL")
    if explicit:
        return explicit
    return build_server_url(require_env("GFE_SERVER_ID"))


def format_duration(total_seconds):
    seconds = max(0, int(total_seconds))
    hours = seconds // 3600
    minutes = (seconds % 3600) // 60
    remain_seconds = seconds % 60
    return f"{hours}h {minutes}m {remain_seconds}s"


def escape_html(text):
    return html.escape(str(text), quote=False)


def http_post_json(url, payload):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read()


def send_telegram_message(token, chat_id, text):
    http_post_json(
        f"https://api.telegram.org/bot{token}/sendMessage",
        {"chat_id": chat_id, "text": text, "parse_mode": "HTML"},
    )


def send_telegram_photo(token, chat_id, photo_path, caption=""):
    boundary = f"----gfe{random.randint(100000, 999999)}"
    photo = Path(photo_path).read_bytes()
    fields = [
        ("chat_id", str(chat_id).encode("utf-8"), None),
        ("caption", caption.encode("utf-8"), None),
        ("parse_mode", b"HTML", None),
        ("photo", photo, Path(photo_path).name),
    ]

    body = bytearray()
    for name, value, filename in fields:
        body.extend(f"--{boundary}\r\n".encode("utf-8"))
        if filename:
            body.extend(
                (
                    f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
                    "Content-Type: image/png\r\n\r\n"
                ).encode("utf-8")
            )
        else:
            body.extend(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"))
        body.extend(value)
        body.extend(b"\r\n")
    body.extend(f"--{boundary}--\r\n".encode("utf-8"))

    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendPhoto",
        data=bytes(body),
        headers={"content-type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def notify_success(token, chat_id, remaining_seconds):
    text = "\n".join([
        "<b>GFE 自动续期成功</b>",
        f"剩余时间: <code>{escape_html(format_duration(remaining_seconds))}</code>",
        f"时间增量: <code>{escape_html(format_duration(EXTEND_SECONDS))}</code>",
        f"冷却时间: <code>{escape_html(format_duration(COOLDOWN_SECONDS))}</code>",
    ])
    send_telegram_message(token, chat_id, text)


def notify_skip(token, chat_id, reason, remaining_seconds=-1, cooldown_seconds=0):
    lines = ["<b>GFE 本轮未续期</b>", escape_html(reason)]
    if remaining_seconds >= 0:
        lines.append(f"剩余时间: <code>{escape_html(format_duration(remaining_seconds))}</code>")
    if cooldown_seconds > 0:
        lines.append(f"冷却剩余: <code>{escape_html(format_duration(cooldown_seconds))}</code>")
    send_telegram_message(token, chat_id, "\n".join(lines))


def notify_failure(token, chat_id, error):
    tail = "\n".join(LOGS[-20:])[:3000]
    text = "\n".join([
        "<b>GFE 自动续期失败</b>",
        f"错误: <code>{escape_html(error)}</code>",
        "",
        "<b>日志片段</b>",
        f"<pre>{escape_html(tail)}</pre>",
    ])
    send_telegram_message(token, chat_id, text)
    if SCREENSHOT_PATH.exists():
        try:
            send_telegram_photo(token, chat_id, SCREENSHOT_PATH, "失败截图")
        except Exception as photo_error:
            log(f"Failed to send screenshot: {photo_error}")


def parse_cookie_header(cookie_header, server_url):
    host = urllib.parse.urlparse(server_url).hostname
    cookies = []
    for item in cookie_header.split(";"):
        item = item.strip()
        if not item or "=" not in item:
            continue
        name, value = item.split("=", 1)
        cookies.append({
            "name": name.strip(),
            "value": value.strip(),
            "domain": host,
            "path": "/",
        })
    return cookies


def save_screenshot(sb, path=SCREENSHOT_PATH):
    ensure_artifacts()
    sb.save_screenshot(str(path))


def read_timer_state(sb):
    script = r"""
        const timer = document.querySelector('[wire\\:name="renewal-timer"]');
        if (!timer) return {error: "renewal timer not found"};
        const attr = timer.getAttribute('wire:snapshot');
        if (!attr) return {error: "wire snapshot missing"};
        const textarea = document.createElement('textarea');
        textarea.innerHTML = attr;
        const snapshot = JSON.parse(textarea.value);
        const data = snapshot.data || {};
        const now = Math.floor(Date.now() / 1000);
        return {
            remainingSeconds: Math.max(0, Number(data.expiresTimestamp || 0) - now),
            cooldownSeconds: data.cooldownExpiry ? Math.max(0, Number(data.cooldownExpiry) - now) : 0,
            expiresTimestamp: Number(data.expiresTimestamp || 0),
            userBalance: Number(data.userBalance || 0)
        };
    """
    state = sb.execute_script(script)
    if not state or state.get("error"):
        raise RuntimeError(state.get("error") if state else "Unable to read renewal timer")
    return state


def is_login_page(sb):
    try:
        return "/login" in sb.get_current_url() or "/oauth2/" in sb.get_current_url()
    except Exception:
        return False


def inject_cookies(sb, cookie_header, server_url):
    for cookie in parse_cookie_header(cookie_header, server_url):
        try:
            sb.add_cookie(cookie)
        except Exception as exc:
            log(f"Cookie inject skipped for {cookie['name']}: {exc}")


def ts_exists(sb):
    try:
        return bool(sb.execute_script("""
            return !!(
                document.querySelector('input[name="cf-turnstile-response"]') ||
                document.querySelector('.cf-turnstile') ||
                document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
                document.body.innerText.includes("Verify you're human")
            );
        """))
    except Exception:
        return False


def ts_solved(sb):
    try:
        return bool(sb.execute_script("""
            const input = document.querySelector('input[name="cf-turnstile-response"]');
            if (input && input.value && input.value.length > 20) return true;
            return !document.body.innerText.includes("Verify you're human") &&
                   !document.querySelector('iframe[src*="challenges.cloudflare.com"]');
        """))
    except Exception:
        return False


def expand_turnstile(sb):
    try:
        sb.execute_script("""
            const input = document.querySelector('input[name="cf-turnstile-response"]');
            let el = input;
            for (let i = 0; i < 20 && el; i++) {
                el = el.parentElement;
                if (!el) break;
                const style = window.getComputedStyle(el);
                if (style.overflow === 'hidden') el.style.overflow = 'visible';
                el.style.minWidth = 'max-content';
            }
            document.querySelectorAll('.cf-turnstile, iframe[src*="challenges.cloudflare.com"]').forEach((node) => {
                node.style.visibility = 'visible';
                node.style.opacity = '1';
                node.style.minWidth = '300px';
                node.style.minHeight = '65px';
            });
        """)
    except Exception:
        pass


def handle_turnstile(sb, timeout=90, auto_wait=25):
    if not ts_exists(sb):
        return True

    log(f"Turnstile detected. Passive wait for up to {auto_wait}s.")
    start = time.time()
    while time.time() - start < auto_wait:
        if not ts_exists(sb) or ts_solved(sb):
            log("Turnstile passed during passive wait.")
            return True
        time.sleep(1)

    log("Passive wait did not pass. Trying SeleniumBase UC captcha helpers.")
    end = time.time() + timeout
    while time.time() < end:
        if not ts_exists(sb) or ts_solved(sb):
            log("Turnstile passed after UC helper attempts.")
            return True

        expand_turnstile(sb)
        try:
            sb.uc_gui_handle_captcha()
        except Exception as exc:
            log(f"uc_gui_handle_captcha failed: {exc}")
        time.sleep(2)

        if not ts_exists(sb) or ts_solved(sb):
            log("Turnstile passed after uc_gui_handle_captcha.")
            return True

        try:
            sb.uc_gui_click_captcha()
        except Exception as exc:
            log(f"uc_gui_click_captcha failed: {exc}")
        time.sleep(2)

    return False


def click_extend(sb):
    selectors = [
        "button.extend",
        "//button[contains(., '+ 90 min')]",
        "//button[contains(., '+90 min')]",
        "//button[contains(., '90 min')]",
    ]
    for selector in selectors:
        try:
            if selector.startswith("//"):
                if sb.is_element_visible(selector):
                    sb.click(selector)
                    return True
            elif sb.is_element_visible(selector):
                sb.click(selector)
                return True
        except Exception:
            continue
    return False


def run():
    ensure_artifacts()
    cookie_header = require_env("GFE_COOKIE")
    bot_token = require_env("TG_BOT_TOKEN")
    chat_id = require_env("TG_CHAT_ID")
    server_url = resolve_server_url()

    log(f"Opening {server_url}")

    with SB(
        uc=True,
        test=True,
        locale="en",
        headless=False,
        chromium_arg=(
            "--disable-dev-shm-usage,--no-sandbox,--disable-gpu,"
            "--disable-blink-features=AutomationControlled"
        ),
    ) as sb:
        sb.uc_open_with_reconnect(BASE_URL, reconnect_time=5)
        inject_cookies(sb, cookie_header, server_url)
        sb.uc_open_with_reconnect(server_url, reconnect_time=5)
        time.sleep(5)

        if is_login_page(sb):
            save_screenshot(sb)
            raise RuntimeError("Cookie login failed. Browser redirected to login/oauth page.")

        handle_turnstile(sb, timeout=30, auto_wait=10)

        before = read_timer_state(sb)
        log(
            "Current state: "
            f"remaining={format_duration(before['remainingSeconds'])}, "
            f"cooldown={format_duration(before['cooldownSeconds'])}, "
            f"balance={before['userBalance']}"
        )

        if before["cooldownSeconds"] > 0:
            save_screenshot(sb)
            notify_skip(bot_token, chat_id, "当前仍处于冷却期。", before["remainingSeconds"], before["cooldownSeconds"])
            return

        if before["remainingSeconds"] >= SAFE_RENEW_THRESHOLD:
            save_screenshot(sb)
            notify_skip(bot_token, chat_id, "剩余时间已接近 72 小时上限，本轮跳过。", before["remainingSeconds"], 0)
            return

        log("Clicking extend button.")
        if not click_extend(sb):
            save_screenshot(sb)
            raise RuntimeError("Extend button was not found.")

        time.sleep(1)
        if ts_exists(sb):
            log("Turnstile challenge appeared after clicking extend.")
            if not handle_turnstile(sb, timeout=90, auto_wait=25):
                save_screenshot(sb)
                raise RuntimeError("Turnstile challenge appeared after clicking extend and was not solved in time.")

        time.sleep(15)
        sb.uc_open_with_reconnect(server_url, reconnect_time=3)
        time.sleep(5)

        after = read_timer_state(sb)
        save_screenshot(sb)
        log(
            "After extend: "
            f"remaining={format_duration(after['remainingSeconds'])}, "
            f"cooldown={format_duration(after['cooldownSeconds'])}"
        )

        gained = after["remainingSeconds"] - before["remainingSeconds"]
        if after["cooldownSeconds"] <= 0 and gained < EXTEND_SECONDS - 300:
            raise RuntimeError(
                f"Renewal result is not credible. Expected about +{EXTEND_SECONDS}s, actual delta={gained}s."
            )

        notify_success(bot_token, chat_id, after["remainingSeconds"])


def main():
    try:
        run()
    except Exception as exc:
        log(f"ERROR: {exc}")
        try:
            token = os.environ.get("TG_BOT_TOKEN", "").strip()
            chat_id = os.environ.get("TG_CHAT_ID", "").strip()
            if token and chat_id:
                notify_failure(token, chat_id, exc)
        except Exception as notify_error:
            log(f"Failure notification failed: {notify_error}")
        raise
    finally:
        persist_logs()


if __name__ == "__main__":
    sys.stdout.reconfigure(line_buffering=True)
    main()
