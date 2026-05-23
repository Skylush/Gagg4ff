#!/usr/bin/env python3
"""
Gaming4Free 自动续期脚本
────────────────────────
优先通过 Playwright 浏览器自动化完成续期（最可靠）；
失败时发送错误日志 + 页面截图到 Telegram。
"""

import os
import sys
import json
import time
import urllib.parse
import traceback
from datetime import datetime, timezone

import requests
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

# ═══════════════════════════════════════════════════════════════════
#  环境变量（全部通过 GitHub Secrets 注入）
# ═══════════════════════════════════════════════════════════════════
TG_BOT_TOKEN  = os.environ["TG_BOT_TOKEN"]
TG_CHAT_ID    = os.environ["TG_CHAT_ID"]
COOKIES_RAW   = os.environ["G4F_COOKIES"]
PANEL_URL     = os.environ.get("PANEL_URL", "https://control.gaming4free.net")
LIVEWIRE_URL  = os.environ.get(
    "LIVEWIRE_URL",
    "https://control.gaming4free.net/livewire-ad07ce4b/update",
)

# 本地临时文件路径
SS_SUCCESS = "/tmp/renew_success.png"
SS_FAIL    = "/tmp/renew_fail.png"
LOG_PATH   = "/tmp/renew_error.log"


# ═══════════════════════════════════════════════════════════════════
#  工具函数
# ═══════════════════════════════════════════════════════════════════

def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def parse_cookies(raw: str) -> list[dict]:
    """将 'key=val; key2=val2' 格式 Cookie 字符串转换为 Playwright cookie list"""
    domain = urllib.parse.urlparse(PANEL_URL).hostname
    result = []
    for part in raw.split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        name, _, value = part.partition("=")
        result.append({
            "name":   name.strip(),
            "value":  value.strip(),
            "domain": domain,
            "path":   "/",
        })
    return result


def get_xsrf_token(raw: str) -> str:
    """从 Cookie 字符串中提取 URL-decoded 的 XSRF-TOKEN"""
    for part in raw.split(";"):
        part = part.strip()
        if part.startswith("XSRF-TOKEN="):
            return urllib.parse.unquote(part[len("XSRF-TOKEN="):])
    return ""


# ═══════════════════════════════════════════════════════════════════
#  Telegram 通知
# ═══════════════════════════════════════════════════════════════════

def _tg_post(method: str, **kwargs):
    url = f"https://api.telegram.org/bot{TG_BOT_TOKEN}/{method}"
    try:
        r = requests.post(url, timeout=20, **kwargs)
        if not r.ok:
            print(f"[TG] {method} 失败: {r.text[:200]}")
    except Exception as e:
        print(f"[TG] {method} 异常: {e}")


def tg_text(text: str):
    _tg_post("sendMessage", json={
        "chat_id":    TG_CHAT_ID,
        "text":       text[:4096],
        "parse_mode": "HTML",
    })


def tg_photo(path: str, caption: str = ""):
    with open(path, "rb") as f:
        _tg_post("sendPhoto",
            data={"chat_id": TG_CHAT_ID, "caption": caption[:1024], "parse_mode": "HTML"},
            files={"photo": ("screenshot.png", f, "image/png")},
        )


def tg_document(path: str, caption: str = ""):
    with open(path, "rb") as f:
        _tg_post("sendDocument",
            data={"chat_id": TG_CHAT_ID, "caption": caption[:1024], "parse_mode": "HTML"},
            files={"document": (os.path.basename(path), f, "text/plain")},
        )


# ═══════════════════════════════════════════════════════════════════
#  方案 A：Playwright 浏览器续期（主力方案）
# ═══════════════════════════════════════════════════════════════════

# 按优先级尝试的续期按钮选择器
RENEW_SELECTORS = [
    # Livewire wire:click 属性
    "[wire\\:click*='renew']",
    "[wire\\:click*='extend']",
    "[wire\\:click*='Renew']",
    "[wire\\:click*='Extend']",
    # 按钮文字（英文 / 中文）
    "button:has-text('Renew')",
    "button:has-text('Extend')",
    "button:has-text('续期')",
    "button:has-text('延期')",
    # 链接
    "a:has-text('Renew')",
    "a:has-text('Extend')",
    # data 属性
    "[data-action*='renew']",
    "[data-action*='extend']",
    # class 名
    "button.renew-btn",
    ".renew button",
]

# 到期时间信息选择器
EXPIRY_SELECTORS = [
    "[class*='expir']",
    "[class*='expire']",
    "[class*='remaining']",
    "[class*='due-date']",
    "[class*='suspension']",
    "text=/\\d+\\s*(day|hour|minute|天|小时|分钟)/i",
]


def playwright_renew() -> str:
    """
    通过 Playwright 打开面板 → 点击续期按钮 → 提取到期信息
    返回: 到期/剩余时间描述字符串
    """
    cookies = parse_cookies(COOKIES_RAW)

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        ctx = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1440, "height": 900},
        )
        ctx.add_cookies(cookies)
        page = ctx.new_page()

        # ── 捕获 Livewire 响应 ───────────────────────────────────
        lw_responses: list[dict] = []

        def on_response(resp):
            if "livewire" in resp.url and resp.status == 200:
                try:
                    lw_responses.append(resp.json())
                except Exception:
                    pass

        page.on("response", on_response)

        # ── 访问面板 ──────────────────────────────────────────────
        print(f"[*] 访问面板: {PANEL_URL}")
        try:
            page.goto(PANEL_URL, wait_until="networkidle", timeout=30_000)
        except PWTimeout:
            page.wait_for_timeout(3000)

        page.wait_for_timeout(2000)

        # ── 查找续期按钮 ──────────────────────────────────────────
        renew_btn = None
        matched_sel = None
        for sel in RENEW_SELECTORS:
            try:
                loc = page.locator(sel).first
                if loc.count() > 0:
                    loc.wait_for(state="visible", timeout=1500)
                    renew_btn = loc
                    matched_sel = sel
                    print(f"[+] 找到续期按钮: {sel}")
                    break
            except Exception:
                continue

        if renew_btn is None:
            page.screenshot(path=SS_FAIL, full_page=True)
            btn_texts = page.locator("button").all_text_contents()[:20]
            all_wires = page.evaluate(
                "() => [...document.querySelectorAll('[wire\\\\:click]')]"
                ".map(e => e.getAttribute('wire:click')).slice(0,10)"
            )
            raise RuntimeError(
                f"❌ 未找到续期按钮\n"
                f"页面按钮: {btn_texts}\n"
                f"wire:click 列表: {all_wires}\n"
                f"当前 URL: {page.url}"
            )

        # ── 点击按钮 ──────────────────────────────────────────────
        print(f"[*] 点击 [{matched_sel}]...")
        renew_btn.scroll_into_view_if_needed()
        renew_btn.click()
        page.wait_for_timeout(4000)   # 等待 Livewire 更新

        # ── 截图 ──────────────────────────────────────────────────
        page.screenshot(path=SS_SUCCESS, full_page=True)
        print(f"[+] 截图已保存: {SS_SUCCESS}")

        # ── 提取到期信息 ──────────────────────────────────────────
        expiry = _extract_expiry(page, lw_responses)
        browser.close()
        return expiry


def _extract_expiry(page, lw_responses: list) -> str:
    """从页面元素或 Livewire 响应中提取到期/剩余时间"""
    # 1) 尝试页面选择器
    for sel in EXPIRY_SELECTORS:
        try:
            loc = page.locator(sel).first
            if loc.count() > 0:
                text = (loc.text_content(timeout=1000) or "").strip()
                if text:
                    print(f"[+] 到期信息 ({sel}): {text}")
                    return text
        except Exception:
            continue

    # 2) 尝试从 Livewire 响应里找关键字
    for lw in lw_responses:
        raw = json.dumps(lw, ensure_ascii=False)
        for kw in ("expir", "suspend", "renew", "days", "remaining", "until"):
            idx = raw.lower().find(kw)
            if idx != -1:
                snippet = raw[max(0, idx - 30): idx + 80]
                return f"Livewire 响应片段: ...{snippet}..."

    # 3) 返回默认
    return "续期请求已发送（页面未检测到剩余时间信息）"


# ═══════════════════════════════════════════════════════════════════
#  方案 B：直接 HTTP POST 到 Livewire 端点（备用，需先拉取快照）
# ═══════════════════════════════════════════════════════════════════

def http_renew() -> str:
    """
    1. GET 面板首页，从 HTML 提取 Livewire 组件快照
    2. POST 到 Livewire 更新端点调用 renew 方法
    """
    import re

    cookies_dict: dict[str, str] = {}
    for part in COOKIES_RAW.split(";"):
        part = part.strip()
        if "=" in part:
            k, _, v = part.partition("=")
            cookies_dict[k.strip()] = v.strip()

    xsrf = get_xsrf_token(COOKIES_RAW)

    session = requests.Session()
    session.cookies.update(cookies_dict)
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Referer": PANEL_URL,
        "X-XSRF-TOKEN": xsrf,
        "X-Livewire": "true",
        "Accept": "text/html, application/xhtml+xml",
        "Content-Type": "application/json",
    }
    session.headers.update(headers)

    # ── 获取页面并提取 Livewire 快照 ─────────────────────────────
    print(f"[*] GET {PANEL_URL}")
    resp = session.get(PANEL_URL, timeout=20)
    resp.raise_for_status()

    # 从 HTML 里提取 wire:snapshot 和 wire:id（Livewire v3 格式）
    snapshot_match = re.search(
        r'wire:snapshot="([^"]+)"', resp.text
    )
    if not snapshot_match:
        raise RuntimeError("未在页面 HTML 中找到 Livewire 快照（wire:snapshot）")

    snapshot_raw = snapshot_match.group(1).replace("&quot;", '"')
    snapshot = json.loads(snapshot_raw)

    # ── POST 调用续期方法 ─────────────────────────────────────────
    # 尝试常见续期方法名
    for method_name in ("renew", "renewServer", "extendServer", "extend", "renewFree"):
        print(f"[*] 尝试调用 Livewire 方法: {method_name}")
        payload = {
            "components": [{
                "snapshot": json.dumps(snapshot),
                "updates":  {},
                "calls":    [{"path": "", "method": method_name, "params": []}],
            }]
        }
        r = session.post(LIVEWIRE_URL, json=payload, timeout=20)
        print(f"    → HTTP {r.status_code}")
        if r.status_code == 200:
            try:
                data = r.json()
                return f"HTTP 续期成功 (method={method_name}): {json.dumps(data)[:200]}"
            except Exception:
                return f"HTTP 续期成功 (method={method_name}), 响应: {r.text[:200]}"

    raise RuntimeError(f"所有 HTTP 续期方法均失败，最后状态码: {r.status_code}")


# ═══════════════════════════════════════════════════════════════════
#  主入口
# ═══════════════════════════════════════════════════════════════════

def main():
    ts = utc_now()
    print(f"\n{'='*55}")
    print(f"  Gaming4Free 续期任务  {ts}")
    print(f"{'='*55}\n")

    expiry_info = None
    error_msg   = None

    # ── 优先：Playwright 方案 ─────────────────────────────────────
    try:
        expiry_info = playwright_renew()
        print(f"[✓] Playwright 续期成功: {expiry_info}")
    except Exception as e1:
        print(f"[!] Playwright 失败: {e1}")
        error_msg = traceback.format_exc()

        # ── 备用：HTTP 方案 ───────────────────────────────────────
        try:
            expiry_info = http_renew()
            print(f"[✓] HTTP 续期成功: {expiry_info}")
            error_msg = None          # 备用方案成功，清除错误
        except Exception as e2:
            error_msg += f"\n\n--- HTTP 备用方案也失败 ---\n{traceback.format_exc()}"
            print(f"[!] HTTP 备用方案也失败: {e2}")

    # ── 发送通知 ──────────────────────────────────────────────────
    if expiry_info is not None:
        # ✅ 成功
        tg_text(
            f"✅ <b>Gaming4Free 续期成功</b>\n"
            f"🕐 <b>时间：</b>{ts}\n"
            f"⏳ <b>服务器信息：</b>{expiry_info}"
        )
        if os.path.exists(SS_SUCCESS):
            tg_photo(SS_SUCCESS, caption=f"✅ 续期成功截图 | {ts}")
        print("[✓] 成功通知已发送")

    else:
        # ❌ 失败
        # 写日志文件
        with open(LOG_PATH, "w", encoding="utf-8") as fh:
            fh.write(f"时间: {ts}\n")
            fh.write(f"面板: {PANEL_URL}\n")
            fh.write(f"Livewire URL: {LIVEWIRE_URL}\n\n")
            fh.write("─── 错误详情 ───\n")
            fh.write(error_msg or "未知错误")

        # 提取最后一行错误作为摘要
        last_err = (error_msg or "未知错误").strip().split("\n")[-1][:400]

        tg_text(
            f"❌ <b>Gaming4Free 续期失败</b>\n"
            f"🕐 <b>时间：</b>{ts}\n"
            f"🔴 <b>错误：</b><code>{last_err}</code>\n\n"
            f"详细日志见附件 ↓"
        )
        tg_document(LOG_PATH, caption=f"❌ 错误日志 | {ts}")

        if os.path.exists(SS_FAIL):
            tg_photo(SS_FAIL, caption="❌ 失败时页面截图")
        elif os.path.exists(SS_SUCCESS):
            tg_photo(SS_SUCCESS, caption="⚠️ 操作时页面截图")

        print("[✗] 失败通知已发送")
        sys.exit(1)


if __name__ == "__main__":
    main()
