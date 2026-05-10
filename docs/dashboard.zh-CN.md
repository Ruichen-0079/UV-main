# Dashboard

`apps/web` 是 AI Companion Runtime 的开发调试 Dashboard。它不是 Live2D avatar UI，也不是最终桌面应用界面。

## 启动方式

推荐从 WSL repo root 启动完整开发环境：

```bash
./scripts/dev.sh
```

打开 Dashboard：

```text
http://localhost:5173
```

如果只启动 Web：

```bash
pnpm --filter @companion/web dev
```

Dashboard 默认通过 Vite proxy 调用后端：

```text
Server: http://localhost:6121
WebSocket: ws://localhost:6121/ws
```

## 页面说明

### Overview

展示 runtime 总览：

- server status
- database status
- provider status
- WebSocket status
- recent events
- recent memories

### Chat

用于发送开发期文本消息，验证 `POST /message`：

- text input
- send button
- chat history
- traceId display
- memory usage toggle
- TTS output toggle

`Use memory` 目前是 UI 选项，后端尚未提供 per-turn memory flag。`TTS output` 会映射到 `voiceOutput`。

### Memory

用于查看和创建 memory：

- `GET /memory/recent`
- `POST /memory`
- memory type filter
- search box

搜索能力会随着 `GET /memory/search?q=` 扩展。

### Providers

用于查看 provider health：

- DeepSeek Chat
- DeepSeek Reasoning
- xAI TTS
- xAI Vision
- Alibaba DashScope STT
- Embedding provider

Dashboard 不显示 API key，不显示 Authorization header，不显示 raw secret。

### Events

用于查看 runtime event：

- `GET /events/recent`
- event type filter
- pause/resume UI

WebSocket 实时事件后续通过 `ws://localhost:6121/ws` 接入。

### Prompt Preview

用于查看最新 prompt preview：

- `GET /debug/prompt/latest`

该能力只应在 development mode 启用。它用于调试 prompt sections、memory reconstruction、token estimate 等，不应该暴露 secret。

### Voice

用于未来 voice 调试：

- Alibaba Cloud DashScope STT
- xAI TTS
- audio/transcript event

当前不实现完整 voice 页面。

### Vision

用于未来 vision 调试：

- xAI Vision
- image/screen perception
- perception.vision event

当前不实现完整 vision 页面。

### Settings

展示开发期只读配置提示：

- API proxy
- server URL
- WebSocket URL
- secret safety reminder

不要在 Dashboard 中输入或展示 API key。

## 架构边界

- Dashboard 只能通过 `apps/server` 暴露的 HTTP/WebSocket API 通信。
- Dashboard 不直接连接 PostgreSQL、Redis、NATS。
- Dashboard 不直接调用 DeepSeek、xAI、DashScope API。
- Dashboard 不保存或打印 `.env` secret。
- Live2D / VRM 不在当前 Dashboard 范围内。
