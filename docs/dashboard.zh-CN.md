# Dashboard

`apps/web` 还没有实现。本文件只记录未来 Web dashboard 的边界和目标。

## Scope

未来 dashboard 应该作为运行时的开发和观察界面，而不是把业务逻辑搬进前端。

计划能力：

- 查看 server、database、provider、memory、event bus 的健康状态。
- 查看运行时事件流和最近的 agent reply。
- 查看记忆检索结果、重要性分数、压缩后的 prompt context。
- 管理 provider 选择和本地开发配置提示，但不显示 secret 明文。
- 为未来 Live2D、VRM、voice、vision 状态提供调试面板。

## Architecture Rules

- Dashboard 通过 `apps/server` 暴露的 HTTP 和 WebSocket API 与 runtime 通信。
- Dashboard 不直接访问 PostgreSQL、Redis、NATS 或 provider API。
- Dashboard 不保存或打印 `.env` secret。
- Dashboard 不应成为生产 desktop mode 的基础设施依赖。

## Current Status

当前 dashboard 未实现，`apps/web` 也未创建。下一步应该先稳定 runtime config、server API 和事件协议，再添加最小 Web dashboard。
