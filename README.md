# GFE 自动续期

这个项目通过 GitHub Actions 定时访问 Gaming4Free 控制面板，在满足条件时自动为服务器续期 90 分钟，并通过 Telegram 推送结果。

项目已经拆出一层可复用基础模块，方便迁移到其他类似面板站点：

- `src/lib/common.js`: 环境变量、日志、Cookie 解析、时间格式化
- `src/lib/browser.js`: Playwright 会话启动、页面日志、跳转校验、截图
- `src/lib/telegram.js`: Telegram 文本/图片通知
- `src/lib/turnstile.js`: Cloudflare Turnstile 的通用检测、聚焦、尝试点击、等待处理

## 功能

- 每 80 分钟执行一次检查
- 剩余时间低于 `70.5 小时` 时才执行续期，避免撞上 `72 小时` 上限
- 单次续期增加 `90 分钟`
- 自动识别 `10 分钟` 冷却期，冷却中不会重复点击
- 成功时推送服务器剩余时间
- 跳过时推送跳过原因
- 失败时推送错误日志，并附带页面截图
- 每次运行都会把日志和截图上传到 GitHub Actions artifact

## 使用的仓库密钥

在 GitHub 仓库 `Settings > Secrets and variables > Actions` 中添加：

- `GFE_COOKIE`: 控制台登录后的完整 Cookie 字符串
- `TG_BOT_TOKEN`: Telegram Bot Token
- `TG_CHAT_ID`: 接收消息的 chat id
- `GFE_SERVER_ID`: 必填，服务器 id
- `GFE_SERVER_URL`: 可选，优先级高于 `GFE_SERVER_ID`，默认会自动拼成 `https://control.gaming4free.net/server/<server_id>/public-renewing`

## 工作方式

脚本会直接打开服务器的 `public-renewing` 页面，读取页面中的 `renewal-timer` 组件快照：

- `expiresTimestamp`: 当前到期时间
- `cooldownExpiry`: 当前冷却结束时间
- `userBalance`: 页面余额字段

如果未处于冷却期且剩余时间未接近上限，就点击 `+ 90 min` 按钮，等待页面刷新后再次读取剩余时间，确认是否续期成功。

当前 GitHub Actions 调度通过两条 cron 组合实现“约每 80 分钟执行一次”：

- `0 */4 * * *`
- `20 1,5,9,13,17,21 * * *`

## 本地运行

1. 安装 Node.js 20+
2. 安装依赖
3. 设置环境变量后执行任务

```bash
npm install
export GFE_COOKIE='你的 cookie'
export TG_BOT_TOKEN='你的 bot token'
export TG_CHAT_ID='你的 chat id'
export GFE_SERVER_ID='你的 server id'
npm run renew
```

## 注意

- Cookie 失效后，任务会跳转到登录页并触发失败通知
- 如果站点后续改版，按钮选择器或组件结构可能需要同步调整，入口脚本在 [src/index.js](/Users/lusky/Downloads/gfe/src/index.js)
