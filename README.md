# GFE 自动续期

这个项目通过 GitHub Actions 定时访问 Gaming4Free 控制面板，在满足条件时自动为服务器续期 90 分钟，并通过 Telegram 推送结果。

## 功能

- 每 10 分钟执行一次检查
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
- `GFE_SERVER_URL`: 可选，默认值是 `https://control.gaming4free.net/server/e7c245d6/public-renewing`

## 工作方式

脚本会直接打开服务器的 `public-renewing` 页面，读取页面中的 `renewal-timer` 组件快照：

- `expiresTimestamp`: 当前到期时间
- `cooldownExpiry`: 当前冷却结束时间
- `userBalance`: 页面余额字段

如果未处于冷却期且剩余时间未接近上限，就点击 `+ 90 min` 按钮，等待页面刷新后再次读取剩余时间，确认是否续期成功。

## 本地运行

1. 安装 Node.js 20+
2. 安装依赖
3. 设置环境变量后执行任务

```bash
npm install
export GFE_COOKIE='你的 cookie'
export TG_BOT_TOKEN='你的 bot token'
export TG_CHAT_ID='你的 chat id'
npm run renew
```

## 注意

- Cookie 失效后，任务会跳转到登录页并触发失败通知
- 如果站点后续改版，按钮选择器或组件结构可能需要同步调整，入口脚本在 [src/index.js](/Users/lusky/Downloads/gfe/src/index.js)
