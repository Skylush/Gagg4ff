import path from "node:path";
import {
  decodeHtmlAttribute,
  formatDuration,
  log,
  persistLogs,
  readOptionalEnv,
  requireEnv
} from "./lib/common.js";
import {
  captureScreenshot,
  closeSession,
  gotoAndVerify,
  launchSession
} from "./lib/browser.js";
import {
  notifyFailure,
  notifySkip,
  notifySuccess
} from "./lib/telegram.js";
import { handleTurnstile, hasTurnstile, waitForTurnstileToClear } from "./lib/turnstile.js";

const DEFAULT_BASE_URL = "https://control.gaming4free.net";
const MAX_SECONDS = 72 * 60 * 60;
const EXTEND_SECONDS = 90 * 60;
const COOLDOWN_SECONDS = 10 * 60;
const SAFE_RENEW_THRESHOLD = MAX_SECONDS - EXTEND_SECONDS;
const WAIT_AFTER_CLICK_MS = 15000;
const ARTIFACT_DIR = path.resolve("artifacts");
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, "renew-page.png");
const LOG_PATH = path.join(ARTIFACT_DIR, "run.log");

function buildServerUrl(serverId) {
  return `${DEFAULT_BASE_URL}/server/${serverId}/public-renewing`;
}

function resolveServerUrl() {
  const explicitUrl = readOptionalEnv("GFE_SERVER_URL");
  if (explicitUrl) {
    return explicitUrl;
  }

  const serverId = requireEnv("GFE_SERVER_ID");
  return buildServerUrl(serverId);
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

async function main() {
  let botToken = "";
  let chatId = "";
  let browser;
  let page;

  try {
    const cookieHeader = requireEnv("GFE_COOKIE");
    botToken = requireEnv("TG_BOT_TOKEN");
    chatId = requireEnv("TG_CHAT_ID");
    const serverUrl = resolveServerUrl();

    log(`Opening ${serverUrl}`);

    ({ browser, page } = await launchSession({
      serverUrl,
      cookieHeader,
      headless: true,
      viewport: { width: 1440, height: 1024 }
    }));

    await gotoAndVerify(page, serverUrl, {
      waitUntil: "networkidle",
      timeout: 60000,
      loginPathHints: ["/login"]
    });

    const turnstileResult = await handleTurnstile(page, { timeoutMs: 15000, probeIntervalMs: 1500 });
    if (turnstileResult.status === "timeout") {
      throw new Error("Turnstile challenge detected but not solved in time.");
    }

    const before = await readTimerState(page);
    log(
      `Current state: remaining=${formatDuration(before.remainingSeconds)}, cooldown=${formatDuration(before.cooldownSeconds)}, balance=${before.userBalance}`
    );

    if (before.cooldownSeconds > 0) {
      await captureScreenshot(page, SCREENSHOT_PATH);
      await notifySkip({
        botToken,
        chatId,
        reason: "当前仍处于冷却期。",
        remainingSeconds: before.remainingSeconds,
        cooldownSeconds: before.cooldownSeconds
      });
      return;
    }

    if (before.remainingSeconds >= SAFE_RENEW_THRESHOLD) {
      await captureScreenshot(page, SCREENSHOT_PATH);
      await notifySkip({
        botToken,
        chatId,
        reason: "剩余时间已接近 72 小时上限，本轮跳过。",
        remainingSeconds: before.remainingSeconds,
        cooldownSeconds: before.cooldownSeconds
      });
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

    const postClickChallenge = await hasTurnstile(page);
    if (postClickChallenge) {
      log("Turnstile challenge appeared after clicking extend. Waiting for verification.");
      const challengeResult = await handleTurnstile(page, {
        timeoutMs: 60000,
        probeIntervalMs: 1500
      });
      if (challengeResult.status === "timeout") {
        throw new Error("Turnstile challenge appeared after clicking extend and was not solved in time.");
      }

      const clearResult = await waitForTurnstileToClear(page, {
        timeoutMs: 30000,
        probeIntervalMs: 1000
      });
      if (clearResult.status === "timeout") {
        throw new Error("Turnstile challenge was solved, but the verification dialog did not clear.");
      }
    }

    await page.waitForTimeout(WAIT_AFTER_CLICK_MS);
    await page.reload({ waitUntil: "networkidle", timeout: 60000 });

    const after = await readTimerState(page);
    await captureScreenshot(page, SCREENSHOT_PATH);
    log(
      `After extend: remaining=${formatDuration(after.remainingSeconds)}, cooldown=${formatDuration(after.cooldownSeconds)}`
    );

    const gainedSeconds = after.remainingSeconds - before.remainingSeconds;
    if (after.cooldownSeconds <= 0 && gainedSeconds < EXTEND_SECONDS - 300) {
      throw new Error(
        `Renewal result is not credible. Expected about +${EXTEND_SECONDS}s, actual delta=${gainedSeconds}s.`
      );
    }

    await notifySuccess({
      botToken,
      chatId,
      remainingSeconds: after.remainingSeconds,
      extendSeconds: EXTEND_SECONDS,
      cooldownSeconds: COOLDOWN_SECONDS
    });
  } catch (error) {
    if (page) {
      try {
        await captureScreenshot(page, SCREENSHOT_PATH);
      } catch (screenshotError) {
        log(`Failed to capture screenshot: ${screenshotError.message}`);
      }
    }

    try {
      if (botToken && chatId) {
        await notifyFailure({
          botToken,
          chatId,
          error,
          screenshotPath: SCREENSHOT_PATH
        });
      } else {
        log("Failure notification skipped because Telegram credentials are unavailable.");
      }
    } catch (notifyError) {
      log(`Failed to send failure notification: ${notifyError.message}`);
    }
    throw error;
  } finally {
    await persistLogs(LOG_PATH);
    await closeSession(browser);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
