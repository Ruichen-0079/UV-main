# YUVI 开发工具链与宿主环境安全

YUVI 的开发工具链必须与宿主登录环境解耦。安装、bootstrap、CI helper 和本地
开发 helper 可以使用临时目录保存一次性事务文件，但临时路径不能被写入任何会在
logout、reboot 或 display-manager session 之间继续存在的配置。

## 路径策略

持久路径由 `@companion/host-environment` 统一解析：

- 配置：`${XDG_CONFIG_HOME:-$HOME/.config}/yuvi/`
- 状态：`${XDG_STATE_HOME:-$HOME/.local/state}/yuvi/`
- 数据：`${XDG_DATA_HOME:-$HOME/.local/share}/yuvi/`
- 缓存：`${XDG_CACHE_HOME:-$HOME/.cache}/yuvi/`
- 用户可执行文件：`$HOME/.local/bin/`
- 工具链环境：`${XDG_CONFIG_HOME:-$HOME/.config}/yuvi/toolchain/env` 和
  `env.fish`

Windows 默认使用 `%APPDATA%\yuvi\` 配置、`%LOCALAPPDATA%\yuvi\` 状态/数据、
`%LOCALAPPDATA%\Temp\yuvi\` 缓存和 `%LOCALAPPDATA%\yuvi\bin\` 用户工具目录；
POSIX shell integration 不在 Windows 上安装。

`/tmp`、`/var/tmp`、`TMPDIR`、`TMP`、`TEMP` 和 `XDG_RUNTIME_DIR` 只允许用于
运行时状态或 installer transaction，不允许成为持久 shell integration 的来源或目标。
`scripts/dev.sh` 使用 `${XDG_RUNTIME_DIR:-/tmp}/yuvi-runtime-dev` 仅保存 PID、日志和
重启标记；它不会把该目录写入 shell 配置。开发子进程使用非 login `bash -c`，从
调用 shell 继承已经导出的 PATH 和环境变量，但不会加载 login profile，避免一次开发
启动被用户 login profile 中的失效 source 阻断。

## Shell integration

默认 writer 不修改 `~/.profile`、`~/.bashrc`、`~/.zshrc` 或用户的
`config.fish`。显式安装时：

- fish 使用独立的 `~/.config/fish/conf.d/yuvi.fish` drop-in；
- POSIX shell 使用 `~/.config/yuvi/shell/yuvi.sh`，不会自动插入 login profile；
- 两者都只在环境文件可读时 source，并吞掉 source 错误，确保缺失文件不会阻断
  shell 或桌面 session；
- writer 只覆盖带有 YUVI begin/end marker 的文件，用户已有文件会触发冲突并保持不变。

所有写入先检查路径安全，创建同目录临时文件，fsync 后 atomic rename；替换或
删除既有 YUVI 文件前会留下带时间戳的 backup。安装事务在后续写入失败时回滚已完成
的写入。已有目录的 canonical 路径也会检查，指向 ephemeral root 的 ancestor symlink
和 managed-file symlink 会被拒绝。重复安装不会产生重复 PATH 或 source block，cleanup
只删除 YUVI 自己的 managed files。

这些检查覆盖稳定存在的 ancestor symlink 和 final symlink；同一用户恶意并发替换路径时
仍存在理论 TOCTOU 窗口。彻底消除这类 race 需要平台特定的 `openat`/`O_NOFOLLOW`
文件句柄协议，超出这个 user-level writer 的范围；atomic rename 本身不会跟随目标文件
symlink。

## 工具提供方式

工具链可分为 system、user-local、project-local 和 ephemeral CI 工具。优先使用
项目 package manager、`node_modules/.bin`、Python venv、`uv run` 或稳定的
`$HOME/.local/bin` wrapper。不要为了单次 Codex/Grok 或 CI session 创建临时工具链，
再把临时 env 文件永久写进 login 配置。

此 hotfix 不会自动改写历史上的 `.profile`、`.bashrc` 或 `.zshrc`；此前已经受影响的
主机仍需单独、明确地清理旧引用。

## 验证

运行：

```sh
pnpm check:host-environment
pnpm --filter @companion/host-environment test
```

测试使用临时 HOME sandbox，覆盖缺失环境文件、POSIX/fish fail-open、连续三次
安装幂等、用户文件冲突保护、cleanup 和 ephemeral-path guard；不会修改真实 HOME。
