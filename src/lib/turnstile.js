const DEFAULT_SELECTORS = [
  'input[name="cf-turnstile-response"]',
  ".cf-turnstile",
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[src*="turnstile"]'
];

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
      continue;
    }

    await page.mouse.move(box.x + Math.min(30, box.width / 4), box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    return true;
  }

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
      continue;
    }

    await page.mouse.click(box.x + Math.min(30, Math.max(12, box.width / 4)), box.y + box.height / 2);
    return true;
  }

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
        await checkbox.click({ timeout: 3000 });
        return true;
      }
    } catch {
      // Ignore and continue through fallbacks.
    }
  }

  if (await clickIframeBox(page)) {
    return true;
  }

  for (const selector of [".cf-turnstile", 'iframe[src*="turnstile"]']) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.count()) {
        await locator.click({ timeout: 3000, force: true });
        return true;
      }
    } catch {
      // Ignore and continue through fallbacks.
    }
  }

  if (await clickWidgetContainer(page)) {
    return true;
  }

  return false;
}

export async function handleTurnstile(page, options = {}) {
  const {
    timeoutMs = 120000,
    probeIntervalMs = 2000
  } = options;

  if (!(await hasTurnstile(page))) {
    return { status: "not_found" };
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isTurnstileSolved(page)) {
      return { status: "solved" };
    }

    await revealTurnstile(page);
    await focusTurnstile(page);
    await tryClickTurnstile(page);
    await page.waitForTimeout(probeIntervalMs);
  }

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
