# Developer Quickstart

[English](quickstart.md) | [简体中文](quickstart.zh-CN.md)

这是当前主要的 Linux 开发路径。Windows 兼容开发说明见 [windows-development.md](windows-development.md)。中文术语遵循 [terminology.zh-CN.md](terminology.zh-CN.md)。

## 1. Prerequisites

- Linux
- Node.js 22 或更新版本
- pnpm `9.15.4`（仓库声明的 package manager）
- 只有在使用仓库 development infrastructure 时才需要 Docker Engine + Compose

检查工具链：

```bash
node --version
pnpm --version
```

需要 container-backed development PostgreSQL 时再检查：

```bash
docker --version
docker compose version
```

## 2. 安装与配置

在仓库根目录执行：

```bash
pnpm install
cp .env.example .env
```

Secret 只放在本地 `.env` / `.env.local`，不要提交或打印。Linux 开发脚本先加载 `.env`，再加载 `.env.local`；同名变量由 `.env.local` 覆盖。

当前支持的 Provider、Memory、media、Live2D 与 Runtime 设置以已提交的 `.env.example` 和当前源码为准。旧文档中的模型或 embedding 假设如果与当前源码/配置冲突，不应继续沿用。

## 3. 启动 YUVI

```bash
./scripts/dev.sh
```

脚本会在需要时安装依赖、加载仓库根环境文件、在未跳过时启动 development infrastructure；如果选择 PostgreSQL Memory 且启用了 auto-migration，还会运行 `pnpm db:migrate`，随后启动 server 与 Web UI。

开发端点：

```text
Runtime API: http://127.0.0.1:6121
Web UI:      http://127.0.0.1:5173
WebSocket:   ws://127.0.0.1:6121/ws
```

检查或停止开发服务：

```bash
./scripts/health.sh
./scripts/stop.sh
```

只做 in-memory 轻量开发时可以跳过 Docker infrastructure：

```bash
SKIP_INFRA=1 ./scripts/dev.sh
```

当所选 repository/provider 不依赖 Compose 服务时，`SKIP_INFRA=1` 是合适的开发路径。

## 4. Durable PostgreSQL

Linux 的主要 durability boundary 是由 `DATABASE_URL` 提供给 YUVI 的 PostgreSQL。它可以来自 system service、独立管理的 container 或其他可达 PostgreSQL instance。

至少设置：

```env
MEMORY_REPOSITORY=postgres
DATABASE_URL=postgres://...
```

如果还需要 raw conversation 在进程重启后恢复：

```env
CONVERSATION_REPOSITORY=postgres
```

在 durable mode 前应用 YUVI migration：

```bash
pnpm db:migrate
```

然后正常启动：

```bash
./scripts/dev.sh
```

YUVI 负责自己的 repository/migration correctness；Linux 上不需要拥有 PostgreSQL 操作系统进程。详见 [p4-linux-first.md](p4-linux-first.md)。

### 可选 development Compose database

仓库 Compose 文件只是一个方便的数据库提供方式：

```bash
docker compose -f infra/docker-compose.yml up -d postgres
pnpm db:migrate
```

它是 development infrastructure，不是概念上的 product-owned persistence architecture。

使用开发容器运行 PostgreSQL smoke path：

```bash
pnpm smoke:postgres
```

只有明确要丢弃 development data 时才删除 volume：

```bash
pnpm db:reset:dev
```

## 5. Provider 与 verification

Provider configuration/readiness 与 live provider observation 是两个不同概念。

- `/health` 与普通 provider status inspection 使用本地配置/readiness 加 cached observation，不执行 live provider probe。
- 显式 **Verify** 可能调用已配置的远端 Provider，也可能产生计费用量。
- Mock Provider 只用于 CI、测试或明确的离线开发，并需要显式启用 mock 配置。

当前已提交示例使用可配置 provider chain 和 generic OpenAI-compatible remote Chat path。Credential 与 model choice 应留在本地配置中，不应硬编码进应用源码。

## 6. Memory 与 embedding

长期 Memory 与 Direct Context 相互独立。Memory retrieval 会保留 `ok`、`empty`、`unavailable`、`error`、`partial`，不会把所有失败都解释成“没有记忆”。

PostgreSQL retrieval 把 exact/lexical signal（包括 trigram 与 full-text）和可选 vector retrieval 结合使用。Embedding 是增强项；embedding failure 必须保留 lexical fallback。

不要把本地 Qwen 512 维目标当成 production default。Qwen MRL validation 属于 measurement-only；512-dimensional transform 还没有在 production source 实现。见 [current-state.zh-CN.md](current-state.zh-CN.md#10-本地-embedding-测量)。

## 7. 验证

仓库变更使用声明的 pnpm 版本和标准 gate：

```bash
pnpm check
pnpm test
pnpm build
git diff --check
```

Linux persistence 另有 dedicated CI workflow，会 provision PostgreSQL + pgvector，并验证 migration 与 PostgreSQL-backed Runtime behavior。

## 8. Windows 兼容

Native Windows PowerShell 开发仍然可用，但它是 Linux 产品开发/验证路径之外的次要兼容流程。见 [windows-development.md](windows-development.md)。Windows packaged-private PostgreSQL ownership 已延后，不是 Linux 产品工作的前置条件。