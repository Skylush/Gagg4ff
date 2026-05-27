import { chromium } from "playwright";

import { log, parseCookieHeader } from "./common.js";

export async function launchSession({
  serverUrl,
  cookieHeader,
  headless = true,
  viewport = { width: 1440, height: 1024 }
}) {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ viewport });

  if (cookieHeader) {
    await context.addCookies(parseCookieHeader(cookieHeader, serverUrl));
  }

  const page = await context.newPage();
  wirePageLogging(page);

  return { browser, context, page };
}

export function wirePageLogging(page) {
  page.on("console", (msg) => log(`PAGE ${msg.type().toUpperCase()}: ${msg.text()}`));
  page.on("pageerror", (err) => log(`PAGEERROR: ${err.message}`));
  page.on("requestfailed", (request) => {
    const failure = request.failure();
    log(`REQUESTFAILED: ${request.method()} ${request.url()} ${failure?.errorText || "unknown"}`);
  });
}

export async function gotoAndVerify(page, url, options = {}) {
  const { waitUntil = "networkidle", timeout = 60000, loginPathHints = ["/login"] } = options;
  await page.goto(url, { waitUntil, timeout });

  if (loginPathHints.some((hint) => page.url().includes(hint))) {
    throw new Error("Cookie login failed. The page redirected to a login route.");
  }
}

export async function captureScreenshot(page, screenshotPath) {
  await page.screenshot({ path: screenshotPath, fullPage: true });
}

export async function closeSession(browser) {
  if (browser) {
    await browser.close();
  }
}
