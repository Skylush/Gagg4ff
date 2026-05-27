import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const runtimeLogs = [];

export function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  runtimeLogs.push(line);
  console.log(line);
}

export function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function readOptionalEnv(name, fallback = "") {
  return process.env[name]?.trim() || fallback;
}

export function parseCookieHeader(cookieHeader, serverUrl) {
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

export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainSeconds = seconds % 60;
  return `${hours}h ${minutes}m ${remainSeconds}s`;
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function decodeHtmlAttribute(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function persistLogs(logPath) {
  await ensureDirectory(path.dirname(logPath));
  await fs.writeFile(logPath, `${runtimeLogs.join("\n")}\n`, "utf8");
}
