# P4 Linux-first rebaseline

This document is the current P4 persistence/reliability baseline. It supersedes the assumption that P4 must complete the Windows packaged-private-PostgreSQL design before Yuvi product work can proceed.

## Product boundary

Linux is the primary development and production-validation platform for P4.

The primary durable architecture is:

```text
Yuvi Runtime / Memory
  -> PostgreSQL repository clients
  -> DATABASE_URL
  -> external, system-managed, or container PostgreSQL
  -> packages/memory/migrations
```

Yuvi core owns these correctness requirements:

- a configured durable repository requires `DATABASE_URL`;
- PostgreSQL must be reachable when durable mode starts or is validated;
- Yuvi migrations must apply successfully before a migrated durable runtime is started;
- finalized-turn lifecycle, durable ingestion state, idempotent delivery, crash recovery, retry/reconcile behavior, and ambiguous-side-effect protection remain intact;
- required memory/persistence failures remain fail-closed at their semantic boundary.

Yuvi core does **not** need to establish operating-system ownership of the PostgreSQL process. PID ownership, executable identity, creation time, process termination authority, Windows ACL/Credential Manager integration, installer-owned PostgreSQL, and bundled PostgreSQL/pgvector are platform-packaging responsibilities.

## Reconstructed P4 state

| Phase | State | Linux-first interpretation |
| --- | --- | --- |
| P4-1 | merged | Finalized-turn lifecycle reliability is frozen reliability behavior. |
| P4-2B | merged | Durable finalized-ingestion ledger is retained. |
| P4-2C1 | merged | Crash-safe idempotent delivery and exact reconciliation primitives are retained. |
| P4-2C2A | merged | Durable coordinator/recovery orchestration is retained. |
| P4-2C2B | merged | Serialized scheduling, retry budget, and ambiguity safety are retained. |
| P4-2D1 | merged | Windows private-PostgreSQL lifecycle substrate is preserved but is no longer the Linux/product gate. |
| P4-2D2 / PR #20 | closed, deferred, not merged | Do not merge or continue wholesale. Separate platform-neutral ideas from Windows packaged ownership/bootstrap machinery. |
| P4-2D3 | not implemented | Packaged private `DATABASE_URL` and default durable wiring are deferred to a future Windows packaging adapter. |
| P4-2D4 | not implemented | Bundled PostgreSQL/pgvector and installer integration are deferred to Windows packaging. |

No repository PR or commit named P4-2A is present in the current GitHub history inspected for this rebaseline; do not invent a missing subphase requirement from chat history.

## Mechanism disposition

| Mechanism | Disposition | Reason |
| --- | --- | --- |
| Finalized-turn lifecycle and sealing/draining | KEEP | Proven semantic-write lifecycle guarantee. |
| PostgreSQL finalized-ingestion parent/child ledger | KEEP | Durable admission and restart-safe state are reliability assets. |
| Stable backend idempotency identity/journal | KEEP | Protects against duplicate semantic effects. |
| `dispatch_started`, lease/version fencing, exact reconciliation | KEEP | Required for crash/ambiguity safety. |
| `MemoryIngestionCoordinator`, wake/poll recovery, retry budget | KEEP | Existing single automatic-delivery owner; do not create a second path. |
| External PostgreSQL through `DATABASE_URL` | KEEP | Primary Linux persistence boundary. |
| Existing SQL migrations and `pnpm db:migrate` | KEEP | Small platform-neutral schema path already used by Linux development. |
| Linux startup orchestration | SIMPLIFY | Require durable config, run migrations, then start Runtime; do not involve PostgreSQL process ownership. |
| PR #20 migration/bootstrap expansion | SIMPLIFY | Keep only future platform-neutral migration safety improvements that have an independently demonstrated need; do not import the supervisor/packaging state machine as a prerequisite. |
| P4-2D1 private PostgreSQL lifecycle code already on main | DEFER_TO_WINDOWS | Preserve it; stop expanding it while Linux product behavior is stabilizing. |
| CIM/WMI/System.Diagnostics/native Windows process identity work | DEFER_TO_WINDOWS | OS packaging concern, not Linux runtime correctness. |
| Windows PostgreSQL ACL/Credential Manager/private-port/termination authority | DEFER_TO_WINDOWS | Packaging adapter responsibility. |
| Packaged private `DATABASE_URL` synthesis and `MEMORY_REPOSITORY=postgres` forcing | DEFER_TO_WINDOWS | Future packaged-adapter integration. |
| Bundled PostgreSQL 16, pgvector resources, NSIS provisioning | DEFER_TO_WINDOWS | Distribution work after product semantics stabilize. |
| PR #20-only superseded process-identity experiments and duplicated supervisor migration orchestration | REMOVE_IF_DEAD | If the old branch is retired, do not port dead experimental machinery to main. |

## PR #20 and the historical Mem0 fail-closed finding

PR #20 added a packaged supervisor schema-bootstrap state (`schemaReady` / memory-search readiness) and historical Windows installer smoke proved a real bug on that branch: Mem0 could still be spawned/published after schema bootstrap failed.

That exact bug is **not present on current main's Linux path**, because current main has not merged the PR #20 schema-bootstrap state machine. Current main already rejects `MEMORY_REPOSITORY=postgres` without `DATABASE_URL`, and the Mem0 sidecar rejects initialization without its PostgreSQL connection string.

Therefore:

- do not transplant the PR #20 Windows supervisor fix into Linux/main;
- if PR #20 is ever resumed for Windows packaging, its Mem0 fail-closed gate remains a real branch-local bug to fix before that packaged path ships;
- Linux fail-closed behavior should stay at the repository/config/migration boundary.

## Linux persistence gate

For durable Linux development or production validation:

```bash
export MEMORY_REPOSITORY=postgres
export DATABASE_URL='postgres://...'
pnpm db:migrate
pnpm build
pnpm smoke
```

A system PostgreSQL service, a separately managed container, or the development `infra/docker-compose.yml` PostgreSQL service are all valid providers of the database. Yuvi does not start, stop, adopt, or kill that database process.

The dedicated Linux persistence CI workflow provisions PostgreSQL + pgvector, runs TypeScript checks, focused memory/core/server tests, migrations, an idempotent migration rerun, and a PostgreSQL-backed runtime smoke.

## Freeze criterion

P4 can be considered frozen for Linux product work when the Linux persistence gate is green on the current P4 rebaseline and no platform-neutral persistence/reliability correctness bug is open. Windows packaged-private-PostgreSQL work does not block that freeze.

Future P4 changes must either fix a demonstrated platform-neutral correctness defect or live in an explicitly scoped platform packaging adapter. Bonsai/local-worker model selection is outside P4.