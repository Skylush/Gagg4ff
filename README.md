# Gaming4Free 自动续期工作流

每 **80 分钟**自动续期一次，续期成功/失败均发送 Telegram 通知。

---

## 文件结构

```
.github/
└── workflows/
    └── g4f-renew.yml      # GitHub Actions 工作流
scripts/
└── g4f_renew.py           # 续期脚本（Playwright + HTTP 双方案）
```

---

## 配置步骤

### 1. Fork / 创建仓库

将本项目推送到你的 GitHub 仓库（可以是 Private）。

---

### 2. 配置 GitHub Secrets

进入仓库 → **Settings → Secrets and variables → Actions → New repository secret**

| Secret 名称    | 说明                             | 示例                                 |
| -------------- | -------------------------------- | ------------------------------------ |
| `TG_BOT_TOKEN` | Telegram Bot Token               | `123456:ABCdef...`                   |
| `TG_CHAT_ID`   | 接收通知的 Chat ID（个人/群组）  | `123456789`                          |
| `G4F_COOKIES`  | 登录 Cookie 字符串（见下方说明） | `_ga=...; remember_web_...=...; ...` |
| `PANEL_URL`    | *(可选)* 面板续期页面 URL        | `https://control.gaming4free.net`    |

---

### 3. 获取 Cookie 字符串

1. 浏览器登录 `https://control.gaming4free.net`
2. 按 **F12** → Network 标签 → 刷新页面
3. 找到任意一个请求，复制请求头中的 `Cookie:` 值
4. 将整行 Cookie 字符串保存到 Secret `G4F_COOKIES`

> ⚠️ Cookie 会过期（通常几天到几周）。过期后续期失败，TG 会收到通知，届时重新获取并更新 Secret 即可。  
> `remember_web_*` 是长效登录 token，只要它有效，其他 Session Cookie 会自动刷新。

---

### 4. 创建 Telegram Bot

1. 在 Telegram 找 `@BotFather`，发送 `/newbot` 创建 Bot
2. 记下 **Bot Token**
3. 向 Bot 发一条消息，然后访问：  
   `https://api.telegram.org/bot<TOKEN>/getUpdates`  
   从返回的 `chat.id` 获取你的 Chat ID

---

### 5. 手动触发测试

1. 仓库 → **Actions** → 左侧 `Gaming4Free Auto Renew`
2. 点击 **Run workflow** → 查看日志
3. 检查 Telegram 是否收到通知

---

## 通知样例

**续期成功：**

```
✅ Gaming4Free 续期成功
🕐 时间：2025-01-15 08:00:00 UTC
⏳ 服务器信息：Expires in 3 days
[附：截图]
```

**续期失败：**

```
❌ Gaming4Free 续期失败
🕐 时间：2025-01-15 08:00:00 UTC
🔴 错误：未找到续期按钮...
详细日志见附件 ↓
[附：error.log + 截图]
```

---

## 工作原理

脚本采用**双方案容错**：

1. **Playwright（主力方案）**：启动无头 Chromium，携带 Cookie 打开面板，自动查找并点击续期按钮，提取剩余到期时间
2. **HTTP 直请求（备用方案）**：获取页面 Livewire 快照后，直接 POST 到 Livewire 更新端点调用续期方法

任一方案成功即算续期完成；两种方案均失败才发送失败通知。

---

## 常见问题

**Q: GitHub Actions 定时任务有延迟？**  
A: GitHub 免费计划高峰期可能延迟 5–15 分钟，不影响续期效果（距 80 分钟上限仍有充裕）。

**Q: 续期按钮找不到？**  
A: 检查失败截图，观察页面按钮名称，在 `scripts/g4f_renew.py` 的 `RENEW_SELECTORS` 列表顶部添加对应选择器，重新推送即可。

**Q: Cookie 多久需要更新一次？**  
A: 视服务提供商而定，一般 7–30 天。TG 收到失败通知后更新 `G4F_COOKIES` Secret 即可。
