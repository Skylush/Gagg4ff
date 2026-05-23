# Gaming4Free 自动续期

每 **80 分钟**自动续期一次，通过 Telegram 通知结果，失败时附带截图和日志链接。

---

## 🚀 部署步骤

### 1. Fork / 上传仓库

将以下文件上传到你的 GitHub 仓库：

```
.github/workflows/renew.yml
scripts/renew.js
package.json
```

### 2. 配置 Repository Secrets

进入仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**，添加以下三个 Secret：

| Secret 名称 | 值 | 说明 |
|---|---|---|
| `GAMING4FREE_COOKIES` | 见下方说明 | 面板登录 Cookie |
| `TG_BOT_TOKEN` | `123456:ABC-DEF...` | BotFather 创建的 Bot Token |
| `TG_CHAT_ID` | `-100xxxxxxxxxx` 或 `@username` | 接收通知的群组/频道/用户 ID |

#### Cookie 获取方式

打开浏览器开发者工具（F12）→ Application → Cookies → `control.gaming4free.net`，
将所有 Cookie 拼接为一行字符串（格式与浏览器 `Cookie` 请求头相同）：

```
_ga=GA1.1.xxx; remember_web_xxx=eyJ...; XSRF-TOKEN=eyJ...; pelican_session=eyJ...
```

> ⚠️ Cookie 有有效期，过期后需要重新登录并更新 Secret。

#### 获取 Telegram Chat ID

1. 将 Bot 加入目标群组或频道
2. 发送一条消息到群组
3. 访问 `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
4. 在返回的 JSON 中找到 `chat.id`

### 3. 手动触发测试

配置完成后，进入 **Actions** → **🔄 Gaming4Free 自动续期** → **Run workflow** 手动测试一次，确认 TG 能收到通知。

---

## 📅 定时计划

每 80 分钟执行一次，一天共 18 次：

```
00:00 → 01:20 → 02:40 → 04:00 → 05:20 → 06:40
08:00 → 09:20 → 10:40 → 12:00 → 13:20 → 14:40
16:00 → 17:20 → 18:40 → 20:00 → 21:20 → 22:40
```

> GitHub Actions 的 cron 时区为 **UTC**，上方时间均为 UTC。

---

## 📬 通知格式

**✅ 续期成功**
```
✅ Gaming4Free 续期成功

🕐 时间：2025/5/24 12:00:00
🌐 HTTP：200
⏳ 服务器剩余到期时间：2025-07-01 00:00:00
```

**❌ 续期失败**
- 发送错误截图（含面板当前状态）
- 附带 HTTP 状态码和响应日志前 800 字符
- 附带 GitHub Actions 完整日志链接

---

## 🔧 常见问题

**Q: 到期时间显示「未能从响应中解析」？**  
A: 该续期接口返回的 JSON 字段名不在预设列表中。可打开 Actions 日志查看完整响应体，然后修改 `scripts/renew.js` 中 `extractExpiry` 函数，添加对应字段名。

**Q: Cookie 失效怎么办？**  
A: 重新登录面板，从浏览器复制最新 Cookie，更新 GitHub Secret 中的 `GAMING4FREE_COOKIES`。

**Q: 如何修改执行间隔？**  
A: 修改 `.github/workflows/renew.yml` 中的 `cron` 表达式。
