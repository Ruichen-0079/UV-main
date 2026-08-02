# Web 控制台

`apps/web` 是 YUVI 运行时的开发调试 Web 控制台。它不是 Live2D 虚拟形象界面，也不是最终桌面应用界面；完整用词见[统一术语表](terminology.zh-CN.md)。

## 启动方式

推荐从 WSL repo root 启动完整开发环境：

```bash
./scripts/dev.sh
```

打开控制台：

```text
http://localhost:5173
```

如果只启动 Web：

```bash
pnpm --filter @companion/web dev
```

控制台默认通过 Vite 代理调用后端：

```text
Server: http://localhost:6121
WebSocket: ws://localhost:6121/ws
```

## 页面说明

### Overview

展示运行时概览：

- server status
- database status
- provider status
- WebSocket status
- recent events
- recent memories

### Chat

用于发送开发期文本消息，验证 `POST /v1/messages`（`POST /message` 为兼容端点）：

- text input
- send button
- chat history
- traceId display
- memory usage toggle
- TTS output toggle

`Use memory` 目前是 UI 选项，后端尚未提供 per-turn memory flag。`TTS output` 会映射到 `voiceOutput`。

### Memory

用于查看和创建记忆：

- `GET /memory/recent`
- `POST /memory`
- memory type filter
- search box

搜索能力会随着 `GET /memory/search?q=` 扩展。

### Providers

用于查看提供方健康状态：

- DeepSeek Chat
- DeepSeek Reasoning
- xAI TTS
- xAI Vision
- 阿里云 DashScope 语音转写
- 向量嵌入提供方

控制台不显示 API key、Authorization header 或原始密钥。

### Events

用于查看运行时事件：

- `GET /events/recent`
- event type filter
- pause/resume UI

WebSocket 实时事件后续通过 `ws://localhost:6121/ws` 接入。

### Prompt Preview

用于查看最新 prompt preview：

- `GET /debug/prompt/latest`

该能力只应在开发模式启用。它用于调试提示词分段、记忆重构、Token 估算等，不应暴露密钥。

### Voice

用于未来语音调试：

- Alibaba Cloud DashScope STT
- xAI TTS
- audio/transcript event

当前不实现完整 voice 页面。

### Vision

用于未来视觉调试：

- xAI Vision
- image/screen perception
- perception.vision event

当前不实现完整 vision 页面。

### Settings

展示开发期只读配置提示：

- API 代理
- 服务器 URL
- WebSocket URL
- 密钥安全提醒

不要在控制台中输入或展示 API key。

## 架构边界

- 控制台只能通过 `apps/server` 暴露的 HTTP/WebSocket API 端点通信。
- 控制台不直接连接 PostgreSQL、Redis、NATS。
- 控制台不直接调用 DeepSeek、xAI、DashScope API。
- 控制台不保存或打印 `.env` 密钥。
- Live2D / VRM 不在当前控制台范围内。
