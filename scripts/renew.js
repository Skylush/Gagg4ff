/**
 * Gaming4Free 自动续期脚本
 * 依赖: playwright, form-data, node-fetch (Node 18+ 内置 fetch)
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const FormData = require('form-data');

// ─── 配置 ─────────────────────────────────────────────────────────────────────
const PANEL_URL  = 'https://control.gaming4free.net';
const RENEW_URL  = 'https://control.gaming4free.net/livewire-ad07ce4b/update';
const BOT_TOKEN  = process.env.TG_BOT_TOKEN;
const CHAT_ID    = process.env.TG_CHAT_ID;
const COOKIE_STR = process.env.GAMING4FREE_COOKIES;
const SCREENSHOT = path.resolve('screenshot.png');

// ─── 工具函数 ──────────────────────────────────────────────────────────────────

/** 解析 Cookie 字符串为键值对象 */
function parseCookies(str) {
  return str.split(';').reduce((acc, part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return acc;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    acc[key] = val;
    return acc;
  }, {});
}

/** 将 Cookie 对象转为 Playwright 可用格式 */
function cookiesToPlaywright(obj, domain) {
  return Object.entries(obj).map(([name, value]) => ({
    name,
    value,
    domain,
    path: '/',
    httpOnly: false,
    secure: true,
    sameSite: 'Lax',
  }));
}

/** 发送 Telegram 文本消息 */
async function tgSendMessage(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('[TG] sendMessage 失败:', err);
  }
}

/** 发送 Telegram 图片（含文字说明） */
async function tgSendPhoto(imgPath, caption) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;
  const form = new FormData();
  form.append('chat_id', CHAT_ID);
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  form.append('photo', fs.createReadStream(imgPath), {
    filename: 'screenshot.png',
    contentType: 'image/png',
  });
  const res = await fetch(url, { method: 'POST', body: form });
  if (!res.ok) {
    const err = await res.text();
    console.error('[TG] sendPhoto 失败:', err);
  }
}

/** 用 Playwright 打开面板截图（保留登录态） */
async function takeScreenshot(cookies) {
  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const ctx  = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const pwCookies = cookiesToPlaywright(cookies, 'control.gaming4free.net');
    await ctx.addCookies(pwCookies);
    const page = await ctx.newPage();
    await page.goto(PANEL_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.screenshot({ path: SCREENSHOT, fullPage: false });
    console.log('[截图] 已保存至', SCREENSHOT);
  } finally {
    if (browser) await browser.close();
  }
}

/** 从响应体中提取到期时间（兼容多种返回格式） */
function extractExpiry(body) {
  try {
    const data = typeof body === 'string' ? JSON.parse(body) : body;

    // 常见字段名：expiry / expired_at / due_date / renewal_date / ends_at
    const candidates = [
      data?.expiry,
      data?.expired_at,
      data?.due_date,
      data?.renewal_date,
      data?.ends_at,
      data?.data?.expiry,
      data?.data?.expired_at,
      data?.effects?.expiry,
    ].filter(Boolean);

    if (candidates.length > 0) return candidates[0];

    // 尝试递归搜索 JSON 中所有包含 "expir" / "due" 的键
    const str = JSON.stringify(data);
    const match = str.match(/"(?:expir[a-z_]*|due_date|ends_at|renewal_date)"\s*:\s*"([^"]+)"/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// ─── 主流程 ────────────────────────────────────────────────────────────────────
async function main() {
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  console.log(`[${now}] 开始执行续期...`);

  if (!COOKIE_STR)  throw new Error('缺少环境变量 GAMING4FREE_COOKIES');
  if (!BOT_TOKEN)   throw new Error('缺少环境变量 TG_BOT_TOKEN');
  if (!CHAT_ID)     throw new Error('缺少环境变量 TG_CHAT_ID');

  const cookies  = parseCookies(COOKIE_STR);
  const xsrfRaw  = cookies['XSRF-TOKEN'] || '';
  // XSRF-TOKEN 在 Cookie 中是 URL 编码的，Header 中需要解码后传输
  const xsrfDecoded = decodeURIComponent(xsrfRaw);

  // ── 构造 Livewire POST 请求 ────────────────────────────────────────────────
  // Livewire v2/v3 update 接口只需要 fingerprint+serverMemo+updates
  // 若服务端仅靠 Session Cookie 鉴权并执行续期，空 updates 即可触发
  const payload = {
    fingerprint: {},
    serverMemo: {},
    updates: [],
  };

  let responseBody = '';
  let httpStatus   = 0;

  try {
    const res = await fetch(RENEW_URL, {
      method: 'POST',
      headers: {
        'Content-Type'    : 'application/json',
        'Accept'          : 'application/json, text/plain, */*',
        'X-Livewire'      : 'true',
        'X-XSRF-TOKEN'    : xsrfDecoded,
        'Referer'         : PANEL_URL,
        'Cookie'          : COOKIE_STR,
        'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Origin'          : PANEL_URL,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify(payload),
    });

    httpStatus   = res.status;
    responseBody = await res.text();
    console.log(`[HTTP] 状态码: ${httpStatus}`);
    console.log(`[HTTP] 响应体: ${responseBody.slice(0, 500)}`);
  } catch (err) {
    // 网络层错误：直接截图并报错
    const errMsg = err.message;
    console.error('[HTTP] 请求失败:', errMsg);

    await takeScreenshot(cookies).catch(e => console.error('[截图] 失败:', e.message));

    const caption = [
      '❌ <b>Gaming4Free 续期失败 — 网络错误</b>',
      '',
      `🕐 时间：${now}`,
      `🔗 接口：<code>${RENEW_URL}</code>`,
      `💥 错误：<code>${errMsg}</code>`,
    ].join('\n');

    if (fs.existsSync(SCREENSHOT)) {
      await tgSendPhoto(SCREENSHOT, caption);
    } else {
      await tgSendMessage(caption);
    }
    process.exit(1);
  }

  // ── 判断续期是否成功 ──────────────────────────────────────────────────────
  const isSuccess = httpStatus >= 200 && httpStatus < 300;

  if (isSuccess) {
    const expiry = extractExpiry(responseBody);
    const expiryLine = expiry
      ? `\n⏳ 服务器剩余到期时间：<b>${expiry}</b>`
      : '\n⏳ 服务器到期时间：<i>（未能从响应中解析，请手动确认）</i>';

    const msg = [
      '✅ <b>Gaming4Free 续期成功</b>',
      '',
      `🕐 时间：${now}`,
      `🌐 HTTP：<code>${httpStatus}</code>`,
      expiryLine,
    ].join('\n');

    await tgSendMessage(msg);
    console.log('[完成] 续期成功，已发送 TG 通知');
  } else {
    // HTTP 错误：截图后上报
    console.error(`[失败] HTTP ${httpStatus}`);

    await takeScreenshot(cookies).catch(e => console.error('[截图] 失败:', e.message));

    // 截取响应日志（最多 800 字符）
    const bodySnippet = responseBody.replace(/<[^>]+>/g, '').slice(0, 800);

    const caption = [
      `❌ <b>Gaming4Free 续期失败 — HTTP ${httpStatus}</b>`,
      '',
      `🕐 时间：${now}`,
      `🔗 接口：<code>${RENEW_URL}</code>`,
      '',
      '📋 <b>响应日志（前 800 字符）：</b>',
      `<pre>${bodySnippet}</pre>`,
    ].join('\n');

    if (fs.existsSync(SCREENSHOT)) {
      await tgSendPhoto(SCREENSHOT, caption.slice(0, 1024)); // Telegram caption 上限 1024
      // 超长日志另发文本
      if (caption.length > 1024) await tgSendMessage(caption);
    } else {
      await tgSendMessage(caption);
    }
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error('[FATAL]', err);
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  await tgSendMessage([
    '💀 <b>Gaming4Free 续期脚本崩溃</b>',
    '',
    `🕐 时间：${now}`,
    `💥 错误：<pre>${String(err).slice(0, 800)}</pre>`,
  ].join('\n')).catch(() => {});
  process.exit(1);
});
