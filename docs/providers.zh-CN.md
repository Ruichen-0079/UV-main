# Providers

运行时使用提供商接口和 `ProviderRegistry`，让核心编排可以调用模型能力，而不需要知道背后是哪一个 vendor SDK 或 HTTP API。

## Default Mapping

- Chat: DeepSeek API
- Reasoning: DeepSeek API
- TTS: xAI
- STT: Alibaba Cloud DashScope
- Vision: xAI
- Embedding: configurable, mock by default for local development

## Why Core Does Not Import Provider SDKs

`packages/core` 必须保持提供商中立。它不应该直接 import DeepSeek、xAI、Alibaba、OpenAI-compatible client 或 vendor SDK。

这样可以让运行时：

- 更容易用 mock provider 测试
- 在没有配置所有 API key 时更安全地本地运行
- 之后更容易替换提供商
- 更不容易把 vendor-specific 响应形状泄漏到提示词、记忆或 protocol event 中
- 在某个 provider API 变化时更有韧性

具体提供商代码属于 `packages/providers/src/<vendor>/`。

## ProviderRegistry

`ProviderRegistry` 是组合边界。它负责提供商选择、env 解析和 fallback 行为。运行时核心依赖 `ProviderResolver` 形状，而不是具体 vendor class。

运行时代码应该按能力请求：

```ts
const chat = providers.getChatProvider();
const reply = await chat.generateReply(input);
```

注册表决定这个提供商是 DeepSeek、xAI、DashScope、mock，还是 unavailable placeholder。

内部实现中，提供商构造按能力组织为 provider-name factory map。要添加另一个 chat、TTS、STT、vision 或 embedding provider，应添加新的 factory entry，而不是在运行时代码里分支。

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

EMBEDDING_PROVIDER=mock
EMBEDDING_API_BASEURL=...
EMBEDDING_API_KEY=...
EMBEDDING_MODEL=...
EMBEDDING_DIMENSIONS=1536
```

如果缺少可选提供商配置并且禁用了 mock，注册表会返回 unavailable provider。`healthCheck()` 会报告 `unavailable`，实际调用会抛出标准化的 `ProviderError`。

## Swapping Providers

添加或替换提供商：

1. 在 `packages/providers/src/types/*` 实现 capability interface。
2. 把 vendor-specific 请求/响应格式化留在 `packages/providers/src/<vendor>/`。
3. 把输出标准化为 `ChatOutput`、`ReasoningOutput`、`TTSOutput`、`STTOutput`、`VisionOutput` 或 embedding array。
4. 在 `ProviderRegistry` 中注册实现。
5. 把 env vars 添加到 `.env.example`。

不要仅仅为了替换 vendor 而修改 `packages/core`。

## Error Normalization

提供商实现应该抛出 `ProviderError`，并使用以下 code 之一：

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

运行时代码不应该检查 vendor-specific error body。

## Security Rules

- 永远不要记录 API key。
- 永远不要提交 `.env`。
- Redact `Authorization` header。
- 不要把原始 provider error 未经标准化直接返回给 client。
- 原始 provider response 只能放在可选 debug 字段中。
- 把本地文件路径和上传媒体视为敏感用户数据。

Fastify logging 已配置为 redact authorization header 和 key-like field。

## Mock Providers

开发和测试可以在没有真实提供商凭据时运行：

```env
NODE_ENV=development
PROVIDER_ALLOW_MOCKS=true
MEMORY_REPOSITORY=memory
```

Mock provider 适用于：

- local server smoke tests
- route tests
- runtime orchestration tests
- CI without vendor credentials

Mock 应该是确定性的、提供商中立的。它们不应该伪装成生产质量。

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
