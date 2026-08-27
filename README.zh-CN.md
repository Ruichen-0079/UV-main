# YUVI Runtime

[English](README.md) | [简体中文](README.zh-CN.md)

YUVI 是一个本地优先、事件驱动的 AI 伴侣运行时。当前产品是一个可运行的 TypeScript monorepo，包含 Fastify runtime server、Web Companion / Web 控制台界面、记忆与会话边界、可替换的提供方链，以及仍在进行打包工作的 Tauri 桌面外壳。

当前已实现的主要能力包括：

- 支持流式和非流式文本回复的普通用户回合；
- 短期直接上下文、可配置的记忆检索、Legacy 与 Mem0 记忆后端，以及 PostgreSQL 持久化会话/记忆路径；
- P4 已定稿回合的摄取持久性、幂等投递、重试/对账、崩溃恢复和持久化边界 fail-closed 行为；
- P6 带有精确 `NO_OP` / `REQUEST_TEXT` 决策边界的助手主动文本回合；
- P7 提供方本地就绪/远程观测诊断、设置事实与重载行为，以及 Voice 和 Vision 开发端点；
- 带有 Lumi Live2D/Cubism 渲染、语音播放和能力门控状态行为的 Web Companion 表现层。

Linux 是主要开发和生产验证平台。Windows 开发兼容路径仍然可用，但 Windows 打包私有 PostgreSQL 的所有权和安装器集成属于延后的打包工作。

## 快速启动

```bash
pnpm install
cp .env.example .env
./scripts/dev.sh
```

脚本会加载仓库根目录的 `.env` 和 `.env.local`，启动可选的开发基础设施；选择持久化 PostgreSQL 模式时会运行 migration，然后启动 server 和 Web UI。只需内存模式时可使用 `SKIP_INFRA=1 ./scripts/dev.sh`。请配置真实 Chat 提供方，或为了离线开发显式开启 mock。持久化模式需要外部、系统管理或独立管理的容器 PostgreSQL，并设置 `DATABASE_URL`；使用前运行 `pnpm db:migrate`。

打开 `http://localhost:5173`。Server 监听 `http://localhost:6121`，WebSocket 端点为 `ws://localhost:6121/ws`。

Windows 用户请从[Windows 开发兼容路径](docs/windows-development.md)开始。WSL 不是产品文档要求，只是受支持的开发环境之一。

## 文档

- [当前状态](docs/current-state.zh-CN.md)——当前、已验证、实验、规划、延后和历史工作的状态权威。
- [架构](docs/architecture.zh-CN.md)
- [开发者快速启动](docs/quickstart.zh-CN.md)
- [P4 Linux-first 持久化基线](docs/p4-linux-first.md)
- [Memory](docs/memory.zh-CN.md)
- [Providers](docs/providers.zh-CN.md)
- [Testing](docs/testing.zh-CN.md)

英文文档入口见 [README.md](README.md)。中文术语以[统一术语表](docs/terminology.zh-CN.md)为准。

## 验证

```bash
pnpm check
pnpm test
pnpm build
git diff --check
```

Provider credential、本地模型服务、数据库 URL 和控制台令牌都应放在未跟踪的本地配置中。不要提交或打印这些值。
