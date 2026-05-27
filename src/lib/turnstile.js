const DEFAULT_SELECTORS = [
  'input[name="cf-turnstile-response"]',
  ".cf-turnstile",
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[src*="turnstile"]'
];

import { log } from "./common.js";

async function humanPause(page, minMs = 120, maxMs = 320) {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  await page.waitForTimeout(delay);
}

async function humanMoveAndClick(page, x, y, label) {
  const start = { x: Math.max(10, x - 80), y: Math.max(10, y - 40) };
  const mid1 = { x: x - 30, y: y - 10 };
  const mid2 = { x: x - 8, y: y + 3 };

  log(`Turnstile click via ${label} at (${Math.round(x)}, ${Math.round(y)})`);

  await page.mouse.move(start.x, start.y, { steps: 8 });
  await humanPause(page, 80, 180);
  await page.mouse.move(mid1.x, mid1.y, { steps: 6 });
  await humanPause(page, 60, 140);
  await page.mouse.move(mid2.x, mid2.y, { steps: 4 });
  await humanPause(page, 40, 120);
  await page.mouse.move(x, y, { steps: 3 });
  await humanPause(page, 120, 280);
  await page.mouse.down();
  await humanPause(page, 70, 160);
  await page.mouse.up();
  await humanPause(page, 300, 700);
}

async function clickIframeBox(page) {
  for (const selector of [
    'iframe[src*="challenges.cloudflare.com"]',
    'iframe[src*="turnstile"]'
  ]) {
    const frameElement = page.locator(selector).first();
    if (!(await frameElement.count())) {
      continue;
    }

    const box = await frameElement.boundingBox();
    if (!box) {
      log(`Turnstile iframe found without bounding box for selector: ${selector}`);
      continue;
    }

    log(
      `Turnstile iframe box ${selector}: x=${Math.round(box.x)} y=${Math.round(box.y)} ` +
      `w=${Math.round(box.width)} h=${Math.round(box.height)}`
    );

    const xOffsets = [26, 30, 34];
    const yOffsets = [0.5, 0.45, 0.55];
    for (let i = 0; i < xOffsets.length; i += 1) {
      const targetX = box.x + Math.min(xOffsets[i], Math.max(18, box.width * 0.22));
      const targetY = box.y + box.height * yOffsets[i];
      await humanMoveAndClick(page, targetX, targetY, `iframe-box-${i + 1}`);
      return true;
    }
  }

  log("Turnstile iframe box click path found no clickable iframe.");
  return false;
}

async function clickWidgetContainer(page) {
  for (const selector of [".cf-turnstile", '[name="cf-turnstile-response"]']) {
    const locator = page.locator(selector).first();
    if (!(await locator.count())) {
      continue;
    }

    const box = await locator.boundingBox();
    if (!box) {
      log(`Turnstile widget selector has no bounding box: ${selector}`);
      continue;
    }

    log(
      `Turnstile widget box ${selector}: x=${Math.round(box.x)} y=${Math.round(box.y)} ` +
      `w=${Math.round(box.width)} h=${Math.round(box.height)}`
    );
    await humanMoveAndClick(
      page,
      box.x + Math.min(30, Math.max(12, box.width / 4)),
      box.y + box.height / 2,
      `widget-${selector}`
    );
    return true;
  }

  log("Turnstile widget container click path found no clickable container.");
  return false;
}

export async function hasTurnstile(page, selectors = DEFAULT_SELECTORS) {
  return page.evaluate((activeSelectors) => {
    return activeSelectors.some((selector) => document.querySelector(selector));
  }, selectors);
}

export async function isTurnstileSolved(page) {
  return page.evaluate(() => {
    const input = document.querySelector('input[name="cf-turnstile-response"]');
    return Boolean(input && input.value && input.value.length > 20);
  });
}

export async function revealTurnstile(page) {
  await page.evaluate(() => {
    const input = document.querySelector('input[name="cf-turnstile-response"]');
    let node = input;

    for (let i = 0; i < 10 && node; i += 1) {
      node = node.parentElement;
      if (!node) {
        break;
      }
      const style = window.getComputedStyle(node);
      if (style.overflow === "hidden") {
        node.style.overflow = "visible";
      }
    }

    for (const selector of [
      ".cf-turnstile",
      'iframe[src*="challenges.cloudflare.com"]',
      'iframe[src*="turnstile"]'
    ]) {
      document.querySelectorAll(selector).forEach((element) => {
        element.style.visibility = "visible";
        element.style.opacity = "1";
      });
    }
  });
}

export async function focusTurnstile(page) {
  await page.evaluate(() => {
    const selectors = [
      ".cf-turnstile",
      'iframe[src*="challenges.cloudflare.com"]',
      'iframe[src*="turnstile"]',
      'input[name="cf-turnstile-response"]'
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) {
        element.scrollIntoView({ block: "center", inline: "center" });
        return true;
      }
    }

    window.scrollTo(0, Math.max(0, document.body.scrollHeight * 0.4));
    return false;
  });
}

export async function tryClickTurnstile(page) {
  for (const frame of page.frames()) {
    try {
      const checkbox = frame.locator('input[type="checkbox"]').first();
      if (await checkbox.count()) {
        log("Turnstile checkbox found inside iframe. Trying direct checkbox click.");
        await checkbox.click({ timeout: 3000, force: true });
        await humanPause(page, 300, 700);
        return true;
      }
    } catch {
      log("Turnstile direct checkbox click failed. Falling back.");
    }
  }

  if (await clickIframeBox(page)) {
    return true;
  }

  for (const selector of [".cf-turnstile", 'iframe[src*="turnstile"]']) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.count()) {
        log(`Turnstile fallback force click on selector: ${selector}`);
        await locator.click({ timeout: 3000, force: true });
        await humanPause(page, 300, 700);
        return true;
      }
    } catch {
      log(`Turnstile fallback force click failed on selector: ${selector}`);
    }
  }

  if (await clickWidgetContainer(page)) {
    return true;
  }

  log("All Turnstile click strategies failed to find a click target.");
  return false;
}

export async function handleTurnstile(page, options = {}) {
  const {
    timeoutMs = 120000,
    probeIntervalMs = 2000,
    autoWaitMs = 8000
  } = options;

  if (!(await hasTurnstile(page))) {
    return { status: "not_found" };
  }

  log("Turnstile detected. Starting solve loop.");
  const startedAt = Date.now();
  const autoWaitDeadline = startedAt + Math.min(autoWaitMs, timeoutMs);
  let attempt = 0;

  log(`Turnstile auto-wait phase started for up to ${autoWaitMs}ms.`);
  while (Date.now() < autoWaitDeadline) {
    attempt += 1;
    if (!(await hasTurnstile(page))) {
      log(`Turnstile cleared automatically after ${attempt} checks.`);
      return { status: "cleared" };
    }
    if (await isTurnstileSolved(page)) {
      log(`Turnstile solved automatically after ${attempt} checks.`);
      return { status: "solved" };
    }
    log(`Turnstile auto-wait check ${attempt}: challenge still present.`);
    await page.waitForTimeout(probeIntervalMs);
  }

  log("Turnstile auto-wait phase ended. Escalating to click fallback.");
  while (Date.now() - startedAt < timeoutMs) {
    attempt += 1;
    if (!(await hasTurnstile(page))) {
      log(`Turnstile cleared after ${attempt} total checks.`);
      return { status: "cleared" };
    }
    if (await isTurnstileSolved(page)) {
      log(`Turnstile solved after ${attempt} total checks.`);
      return { status: "solved" };
    }
    log(`Turnstile attempt ${attempt}: revealing, focusing, and clicking.`);
    await revealTurnstile(page);
    await focusTurnstile(page);
    await tryClickTurnstile(page);
    await page.waitForTimeout(probeIntervalMs);
  }

  log(`Turnstile solve loop timed out after ${attempt} attempts.`);
  return { status: "timeout" };
}

export async function waitForTurnstileToClear(page, options = {}) {
  const {
    timeoutMs = 30000,
    probeIntervalMs = 1000
  } = options;

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const exists = await hasTurnstile(page);
    if (!exists) {
      return { status: "cleared" };
    }

    if (await isTurnstileSolved(page)) {
      return { status: "solved" };
    }

    await page.waitForTimeout(probeIntervalMs);
  }

  return { status: "timeout" };
}
