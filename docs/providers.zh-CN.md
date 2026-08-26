# Providers

运行时使用能力提供方接口和 `ProviderRegistry`，让核心编排可以调用模型能力，而不需要知道背后是哪一个厂商 SDK 或 HTTP API。中文术语以[统一术语表](terminology.zh-CN.md)为准。

## Default Mapping

- Chat: DeepSeek API
- Reasoning: DeepSeek API
- TTS: xAI
- STT: Alibaba Cloud DashScope
- Vision: xAI
- Embedding: configurable, mock by default for local development

## Why Core Does Not Import Provider SDKs

`packages/core` 必须保持提供方中立。它不应直接 import DeepSeek、xAI、Alibaba、OpenAI-compatible client 或厂商 SDK。

这样可以让运行时：

- 更容易用模拟提供方测试
- 在没有配置所有 API key 时更安全地本地运行
- 之后更容易替换提供方
- 更不容易把厂商专用响应形状泄漏到提示词、记忆或协议事件中
- 在某个提供方 API 变化时更有韧性

具体提供方代码属于 `packages/providers/src/<vendor>/`。

## ProviderRegistry

`ProviderRegistry` 是组合边界。它负责提供方选择、环境变量解析和回退行为。运行时核心依赖 `ProviderResolver` 形状，而不是具体厂商类。

运行时代码应该按能力请求：

```ts
const chat = providers.getChatProvider();
const reply = await chat.generateReply(input);
```

注册表决定这个提供方是 DeepSeek、xAI、DashScope、模拟提供方，还是不可用占位实现。

Provider 状态有两条相互独立的轴：`readiness` 表示本地配置是否足以构造路由，
不代表远程可达；`observed` 表示最近一次明确 live verification 的缓存结果，初始值
通常为 `unknown`。`/providers/status` 和 `/health` 的提供方检查不执行远程 provider
I/O。缓存只属于当前 `ProviderRegistry` 实例；运行时配置 reload 替换注册表后，观察值
会重置为 `unknown`，不会持久化或复制。

TTS、STT、Vision 的 `/providers/verify/*` 在 v1 只做 config-only 检查，不调用 provider，
也不会更新 `observed`。`/providers/verify-chain/:capability` 同样只检查路由配置；未调用
的路由在 `attemptedProviders` 中标记为 `skipped`，不会伪装成 live `success`。Chat、Reasoning
和 Embedding 的显式 live verification 可能产生 provider I/O 和费用。

内部实现中，提供方构造按能力组织为 provider-name factory map。要添加另一个对话、语音合成、语音转写、视觉理解或向量嵌入提供方，应添加新的 factory entry，而不是在运行时代码里分支。

当前注册表入口：

```ts
const providers = createProviderRegistryFromEnv();
```

`packages/config` 提供 provider-neutral 的 typed config、env parsing、validation 和 redaction helper。它只描述配置边界，不实例化具体 provider，也不 import DeepSeek、xAI 或 DashScope class。具体 provider client 的装配仍留在 `packages/providers`。

## Required Environment

对 MVP 来说，production-like 模式需要这些变量：

```env
NODE_ENV=production
SERVER_HOST=127.0.0.1
SERVER_PORT=3000

DATABASE_URL=postgres://...
REDIS_URL=redis://...

DEFAULT_CHAT_PROVIDER=deepseek
DEEPSEEK_API_BASEURL=https://api.deepseek.com
DEEPSEEK_API_KEY=...
DEEPSEEK_CHAT_MODEL=...
```

对于 DeepInfra、OpenRouter 等远程 OpenAI-compatible Chat 网关，可使用独立的
Chat provider identity：

```env
DEFAULT_CHAT_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_API_BASEURL=https://api.deepinfra.com/v1/openai
OPENAI_COMPATIBLE_API_KEY=...
OPENAI_COMPATIBLE_CHAT_MODEL=deepseek-ai/DeepSeek-V4-Flash-0731
OPENAI_COMPATIBLE_PROACTIVE_DECISION_MODEL=meta-llama/Llama-3.3-70B-Instruct-Turbo
OPENAI_COMPATIBLE_ASSISTANT_CONTINUATION_FORMAT=deepseek-v4
```

该 provider 只负责 Chat，复用现有 `/chat/completions` streaming transport；model
ID 原样传递，API key 只作为 Bearer credential 发送，不会出现在 status/log 中。

P6 通过同一个通用网关 credential 使用两个窄能力：decision model 只返回
`NO_OP` 或 `REQUEST_TEXT`；仅在 `REQUEST_TEXT` 时，才由已配置的 Chat model
生成一条简短的 assistant continuation。`deepseek-v4` 显式选择该模型族的 raw
`/completions` assistant cue，不会根据 provider 或 model 名称猜测。普通用户 Chat
仍使用原有 `/chat/completions` streaming 路径。

Reasoning 也默认使用 DeepSeek：

```env
DEFAULT_REASONING_PROVIDER=deepseek
DEEPSEEK_REASONING_MODEL=...
```

## Optional Providers

这些对于第一个 text-chat MVP 是可选的：

```env
DEFAULT_TTS_PROVIDER=xai
XAI_API_BASEURL=https://api.x.ai/v1
XAI_API_KEY=...
XAI_TTS_MODEL=...
XAI_TTS_VOICE=...

DEFAULT_STT_PROVIDER=dashscope
DASHSCOPE_API_BASEURL=https://dashscope.aliyuncs.com/api/v1
DASHSCOPE_API_KEY=...
DASHSCOPE_STT_MODEL=...

DEFAULT_VISION_PROVIDER=xai
XAI_VISION_MODEL=...

EMBEDDING_PROVIDER=openai-compatible
EMBEDDING_API_BASEURL=...
EMBEDDING_API_KEY=...
EMBEDDING_MODEL=...
EMBEDDING_DIMENSIONS=1536
```

YUVI 默认采用 real-provider-first。`EMBEDDING_PROVIDER=openai-compatible` 会在配置 `EMBEDDING_API_BASEURL`、`EMBEDDING_API_KEY`、`EMBEDDING_MODEL` 和 `EMBEDDING_DIMENSIONS` 后调用 OpenAI-style `/embeddings` endpoint。`EMBEDDING_PROVIDER=mock` 只用于测试、CI 或显式离线模式，并会报告 `semanticEmbedding=false`，表示它只能验证检索管线，不能提供真实语义相似度。Embedding status 只返回 provider、model、dimensions、mock/configured/available 状态，绝不返回 API key。

如果缺少可选提供方配置并且禁用了模拟实现，注册表会将路由报告为本地
`not_ready`/`unavailable`；实际调用会抛出标准化的 `ProviderError`。状态和健康检查
不会把这个配置结果升级为远程探测。

## Swapping Providers

添加或替换提供方：

1. 在 `packages/providers/src/types/*` 实现 capability interface。
2. 把 vendor-specific 请求/响应格式化留在 `packages/providers/src/<vendor>/`。
3. 把输出标准化为 `ChatOutput`、`ReasoningOutput`、`TTSOutput`、`STTOutput`、`VisionOutput` 或 embedding array。
4. 在 `ProviderRegistry` 中注册实现。
5. 把 env vars 添加到 `.env.example`。

不要仅仅为了替换 vendor 而修改 `packages/core`。

## Error Normalization

提供方实现应该抛出 `ProviderError`，并使用以下 code 之一：

- `MISSING_API_KEY`
- `INVALID_API_KEY`
- `PERMISSION_DENIED`
- `MODEL_NOT_FOUND`
- `RATE_LIMITED`
- `TIMEOUT`
- `NETWORK_ERROR`
- `MALFORMED_RESPONSE`
- `UNSUPPORTED_INPUT`
- `PROVIDER_UNAVAILABLE`

`ProviderError` 有三条独立策略轴：

- `retryable`：同一提供方稍后可能成功。P7-4B 不会自动同提供方重试。
- `fallbackEligible`：该错误本身允许切换提供方身份。
- `effectState`：`not_started` / `unknown` / `committed`。是否可重放由 `effectState !== "committed"` 派生，不是可独立赋值的布尔值。

`ProviderRouteStatus.fallbackEligible` 仍是 P7-2 的路由就绪投影，不是调用错误的切换许可。`Cancelled` 永不重试、永不 fallback。本地 `UNSUPPORTED_INPUT` 会停止链路；带 HTTP 状态的厂商输入拒绝可以 fallback。Chat 在首个可见 delta 之前可以 fallback（包括 `INVALID_API_KEY`），可见输出之后不能 fallback。

运行时代码不应该检查 vendor-specific error body。内部策略字段不会进入公开 SSE/JSON。

## Security Rules

- 永远不要记录 API key。
- 永远不要提交 `.env`。
- Redact `Authorization` header。
- 不要把原始 provider error 未经标准化直接返回给 client。
- 原始 provider response 只能放在可选 debug 字段中。
- 把本地文件路径和上传媒体视为敏感用户数据。

Fastify logging 已配置为 redact authorization header 和 key-like field。

## Mock Providers

正常开发/运行不再静默 fallback 到 mock。测试、CI 或显式离线开发可以开启：

```env
NODE_ENV=development
PROVIDER_ALLOW_MOCKS=true
MEMORY_REPOSITORY=in-memory
EMBEDDING_PROVIDER=mock
```

Mock provider 适用于：

- local server smoke tests
- route tests
- runtime orchestration tests
- CI without vendor credentials

模拟提供方应该是确定性的、提供方中立的。它们不应该伪装成生产质量。

## Raw Provider Responses

标准化 provider output 默认不包含原始 vendor response。仅本地调试时设置：

```env
PROVIDER_INCLUDE_RAW_RESPONSES=true
```

运行时事件绝不能包含原始 provider response。请把它们视为敏感数据，因为其中可能包含提示词、transcript、媒体 metadata 或 vendor-specific payload details。

## Future Work

计划中的 provider 扩展：

- streaming TTS over WebSocket or chunked audio events
- streaming STT for live microphone input
- vision screen sharing and frame sampling
- local embedding models for fully local memory search
- NATS-backed provider task events for long-running jobs

这些都应该保持同一条边界：core 使用接口，registry 负责装配实现。
