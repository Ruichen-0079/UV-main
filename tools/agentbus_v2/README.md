# AgentBus v2

AgentBus v2 runs one P by rereading immutable facts on every tick:

```text
PLAN -> WORK -> PROVE -> MERGE -> DONE
```

`FAIL` is sent to a semantic GPT `JUDGE`; corrections are only
`RETURN_PLAN`, `RETURN_WORK`, or `RETURN_PROVE`. `ABSENT` means the tick sleeps
and recomputes. There is no persisted phase, current step, repair state, repair
budget, or workflow WAIT state.

The default GPT adapter is manual. It writes a self-contained prompt to the P's
`gpt/outbox` and accepts only a strict response with the same deterministic
`JOB_ID` through `gpt-submit`. Browser lane or conversation identity is not part
of correctness.

The local P directory contains only the immutable charter, content-addressed
requests/results/evidence, and operational leases. The default location is
`$XDG_STATE_HOME/yuvi-agentbus-v2`, or
`~/.local/state/yuvi-agentbus-v2`.

```bash
scripts/agentbus-v2 init P-ID \
  --charter /path/to/charter.md \
  --worktree /path/to/independent/worktree \
  --repository github.com/OWNER/REPO \
  --branch agentbus/p-id

scripts/agentbus-v2 tick P-ID
scripts/agentbus-v2 watch P-ID --interval 20
scripts/agentbus-v2 gpt-submit P-ID /path/to/response.json
```

`--allow-merge` is false unless supplied to the process. With every proof and
fence satisfied, the default outcome is `MERGE_READY`. A permitted merge
rereads the repository, P, PR, HEAD, live BASE, SPEC, WORK, PROVE, draft,
mergeability, drift, and owned-resource identities immediately before calling
GitHub with an exact expected HEAD. GitHub has no atomic expected-BASE argument;
Experiment 1 therefore keeps merge permission off even after these final
read-time fences pass.

Successful WORK commits carry deterministic P/SPEC/WORK/input-HEAD trailers.
That lets a restarted tick recover a commit made just before an executor crash
without storing executor lifecycle state. `watch` has a small in-memory fuse for
an identical WORK effect that repeatedly exits without any durable fact.

Watched-resource fingerprints and not-before scheduling are deliberately
deferred for Experiment 1. A GPT `WAIT` therefore stops as `HUMAN` for manual
wake handling; it never creates a persisted workflow WAIT state.
