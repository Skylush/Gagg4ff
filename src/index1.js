import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const DEFAULT_BASE_URL = "https://control.gaming4free.net";
const MAX_SECONDS = 72 * 60 * 60;
const EXTEND_SECONDS = 90 * 60;
const COOLDOWN_SECONDS = 10 * 60;
const SAFE_RENEW_THRESHOLD = MAX_SECONDS - EXTEND_SECONDS;
const WAIT_AFTER_CLICK_MS = 15000;
const ARTIFACT_DIR = path.resolve("artifacts");
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, "renew-page.png");
const LOG_PATH = path.join(ARTIFACT_DIR, "run.log");

const runtimeLogs = [];

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  runtimeLogs.push(line);
  console.log(line);
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readOptionalEnv(name, fallback = "") {
  return process.env[name]?.trim() || fallback;
}

function buildServerUrl(serverId) {
  return `${DEFAULT_BASE_URL}/server/${serverId}/public-renewing`;
}

function parseCookieHeader(cookieHeader, serverUrl) {
  const url = new URL(serverUrl);

  return cookieHeader
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separatorIndex = item.indexOf("=");
      if (separatorIndex === -1) {
        return null;
      }

      const name = item.slice(0, separatorIndex).trim();
      const value = item.slice(separatorIndex + 1).trim();
      if (!name) {
        return null;
      }

      return {
        name,
        value,
        domain: url.hostname,
        path: "/",
        httpOnly: false,
        secure: url.protocol === "https:",
        sameSite: "Lax"
      };
    })
    .filter(Boolean);
}

function decodeHtmlAttribute(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function readTimerState(page) {
  const timer = page.locator('[wire\\:name="renewal-timer"]').first();
  await timer.waitFor({ state: "visible", timeout: 30000 });

  const snapshotAttr = await timer.getAttribute("wire:snapshot");
  if (!snapshotAttr) {
    throw new Error("Unable to read renewal timer snapshot.");
  }

  const snapshot = JSON.parse(decodeHtmlAttribute(snapshotAttr));
  const data = snapshot.data ?? {};
  const remainingSeconds = Math.max(
    0,
    Number(data.expiresTimestamp || 0) - Math.floor(Date.now() / 1000)
  );
  const cooldownSeconds = data.cooldownExpiry
    ? Math.max(0, Number(data.cooldownExpiry) - Math.floor(Date.now() / 1000))
    : 0;

  return {
    remainingSeconds,
    cooldownSeconds,
    expiresTimestamp: Number(data.expiresTimestamp || 0),
    userBalance: Number(data.userBalance || 0)
  };
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainSeconds = seconds % 60;
  return `${hours}h ${minutes}m ${remainSeconds}s`;
}

async function ensureArtifactsDir() {
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
}

async function persistLogs() {
  await ensureArtifactsDir();
  await fs.writeFile(LOG_PATH, `${runtimeLogs.join("\n")}\n`, "utf8");
}

async function sendTelegramMessage({ botToken, chatId, text }) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML"
    })
  });

  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed: ${response.status} ${await response.text()}`);
  }
}

async function sendTelegramPhoto({ botToken, chatId, filePath, caption = "" }) {
  const buffer = await fs.readFile(filePath);
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", caption);
  form.append("photo", new Blob([buffer]), path.basename(filePath));

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
    method: "POST",
    body: form
  });

  if (!response.ok) {
    throw new Error(`Telegram sendPhoto failed: ${response.status} ${await response.text()}`);
  }
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function notifySuccess(botToken, chatId, remainingSeconds) {
  const text = [
    "<b>GFE-US 自动续期成功</b>",
    `剩余时间: <code>${escapeHtml(formatDuration(remainingSeconds))}</code>`,
    `时间增量: <code>${escapeHtml(formatDuration(EXTEND_SECONDS))}</code>`,
    `冷却时间: <code>${escapeHtml(formatDuration(COOLDOWN_SECONDS))}</code>`
  ].join("\n");

  await sendTelegramMessage({ botToken, chatId, text });
}

async function notifySkip(botToken, chatId, reason, remainingSeconds, cooldownSeconds) {
  const lines = ["<b>GFE-US 本轮未续期</b>", escapeHtml(reason)];

  if (remainingSeconds >= 0) {
    lines.push(`剩余时间: <code>${escapeHtml(formatDuration(remainingSeconds))}</code>`);
  }

  if (cooldownSeconds > 0) {
    lines.push(`冷却剩余: <code>${escapeHtml(formatDuration(cooldownSeconds))}</code>`);
  }

  await sendTelegramMessage({ botToken, chatId, text: lines.join("\n") });
}

async function notifyFailure(botToken, chatId, error) {
  const tailLogs = runtimeLogs.slice(-20).join("\n");
  const message = [
    "<b>GFE-US 自动续期失败</b>",
    `错误: <code>${escapeHtml(error.message || String(error))}</code>`,
    "",
    "<b>日志片段</b>",
    `<pre>${escapeHtml(tailLogs.slice(0, 3000))}</pre>`
  ].join("\n");

  await sendTelegramMessage({ botToken, chatId, text: message });

  try {
    await fs.access(SCREENSHOT_PATH);
    await sendTelegramPhoto({
      botToken,
      chatId,
      filePath: SCREENSHOT_PATH,
      caption: "失败截图"
    });
  } catch {
    log("Screenshot not available for Telegram notification.");
  }
}

async function main() {
  const cookieHeader = requireEnv("GFE_COOKIE");
  const botToken = requireEnv("TG_BOT_TOKEN");
  const chatId = requireEnv("TG_CHAT_ID");
  const serverId = requireEnv("GFE_SERVER_ID");
  const serverUrl = readOptionalEnv("GFE_SERVER_URL", buildServerUrl(serverId));

  let browser;
  let page;

  try {
    await ensureArtifactsDir();
    log(`Opening ${serverUrl}`);

    browser = await chromium.launch({
      headless: true
    });

    const context = await browser.newContext({
      viewport: { width: 1440, height: 1024 }
    });

    await context.addCookies(parseCookieHeader(cookieHeader, serverUrl));
    page = await context.newPage();

    page.on("console", (msg) => log(`PAGE ${msg.type().toUpperCase()}: ${msg.text()}`));
    page.on("pageerror", (err) => log(`PAGEERROR: ${err.message}`));
    page.on("requestfailed", (request) => {
      const failure = request.failure();
      log(`REQUESTFAILED: ${request.method()} ${request.url()} ${failure?.errorText || "unknown"}`);
    });

    await page.goto(serverUrl, { waitUntil: "networkidle", timeout: 60000 });

    if (page.url().includes("/login")) {
      throw new Error("Cookie login failed. The server redirected to the login page.");
    }

    const before = await readTimerState(page);
    log(
      `Current state: remaining=${formatDuration(before.remainingSeconds)}, cooldown=${formatDuration(before.cooldownSeconds)}, balance=${before.userBalance}`
    );

    if (before.cooldownSeconds > 0) {
      await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
      await notifySkip(botToken, chatId, "当前仍处于冷却期。", before.remainingSeconds, before.cooldownSeconds);
      return;
    }

    if (before.remainingSeconds >= SAFE_RENEW_THRESHOLD) {
      await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
      await notifySkip(
        botToken,
        chatId,
        "剩余时间已接近 72 小时上限，本轮跳过。",
        before.remainingSeconds,
        before.cooldownSeconds
      );
      return;
    }

    const extendButton = page.locator("button.extend").first();
    await extendButton.waitFor({ state: "visible", timeout: 30000 });

    const disabled = await extendButton.isDisabled();
    if (disabled) {
      throw new Error("Extend button is disabled while the page reports no cooldown.");
    }

    log("Clicking extend button.");
    await extendButton.click({ timeout: 30000 });
    await page.waitForTimeout(WAIT_AFTER_CLICK_MS);
    await page.reload({ waitUntil: "networkidle", timeout: 60000 });

    const after = await readTimerState(page);
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    log(
      `After extend: remaining=${formatDuration(after.remainingSeconds)}, cooldown=${formatDuration(after.cooldownSeconds)}`
    );

    const gainedSeconds = after.remainingSeconds - before.remainingSeconds;
    if (after.cooldownSeconds <= 0 && gainedSeconds < EXTEND_SECONDS - 300) {
      throw new Error(
        `Renewal result is not credible. Expected about +${EXTEND_SECONDS}s, actual delta=${gainedSeconds}s.`
      );
    }

    await notifySuccess(botToken, chatId, after.remainingSeconds);
  } catch (error) {
    if (page) {
      try {
        await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
      } catch (screenshotError) {
        log(`Failed to capture screenshot: ${screenshotError.message}`);
      }
    }

    try {
      await notifyFailure(botToken, chatId, error);
    } catch (notifyError) {
      log(`Failed to send failure notification: ${notifyError.message}`);
    }
    throw error;
  } finally {
    await persistLogs();
    if (browser) {
      await browser.close();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
