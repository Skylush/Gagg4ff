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
