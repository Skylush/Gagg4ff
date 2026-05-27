import fs from "node:fs/promises";
import path from "node:path";

import { escapeHtml, formatDuration, runtimeLogs } from "./common.js";

export async function sendTelegramMessage({ botToken, chatId, text }) {
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

export async function sendTelegramPhoto({ botToken, chatId, filePath, caption = "" }) {
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

export async function notifySuccess({
  botToken,
  chatId,
  remainingSeconds,
  extendSeconds,
  cooldownSeconds
}) {
  const text = [
    "<b>GFE-US 自动续期成功</b>",
    `剩余时间: <code>${escapeHtml(formatDuration(remainingSeconds))}</code>`,
    `时间增量: <code>${escapeHtml(formatDuration(extendSeconds))}</code>`,
    `冷却时间: <code>${escapeHtml(formatDuration(cooldownSeconds))}</code>`
  ].join("\n");

  await sendTelegramMessage({ botToken, chatId, text });
}

export async function notifySkip({
  botToken,
  chatId,
  reason,
  remainingSeconds = -1,
  cooldownSeconds = 0
}) {
  const lines = ["<b>GFE-US 本轮未续期</b>", escapeHtml(reason)];

  if (remainingSeconds >= 0) {
    lines.push(`剩余时间: <code>${escapeHtml(formatDuration(remainingSeconds))}</code>`);
  }

  if (cooldownSeconds > 0) {
    lines.push(`冷却剩余: <code>${escapeHtml(formatDuration(cooldownSeconds))}</code>`);
  }

  await sendTelegramMessage({ botToken, chatId, text: lines.join("\n") });
}

export async function notifyFailure({ botToken, chatId, error, screenshotPath }) {
  const tailLogs = runtimeLogs.slice(-20).join("\n");
  const message = [
    "<b>GFE-US 自动续期失败</b>",
    `错误: <code>${escapeHtml(error.message || String(error))}</code>`,
    "",
    "<b>日志片段</b>",
    `<pre>${escapeHtml(tailLogs.slice(0, 3000))}</pre>`
  ].join("\n");

  await sendTelegramMessage({ botToken, chatId, text: message });

  if (!screenshotPath) {
    return;
  }

  try {
    await fs.access(screenshotPath);
    await sendTelegramPhoto({
      botToken,
      chatId,
      filePath: screenshotPath,
      caption: "失败截图"
    });
  } catch {
    // Ignore screenshot notification failures.
  }
}
