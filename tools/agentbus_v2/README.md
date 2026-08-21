# AgentBus v2

AgentBus v2 runs one P by rereading immutable facts on every tick:

```text
PLAN -> WORK -> PROVE -> MERGE -> DONE
```

`FAIL` is sent to a semantic GPT `JUDGE`; corrections are only
`RETURN_PLAN`, `RETURN_WORK`, or `RETURN_PROVE`. `ABSENT` means the tick sleeps
and recomputes. There is no persisted phase, current step, repair state, repair
budget, or workflow WAIT state.

The default GPT adapter is manual. It writes one immutable, self-contained
packet to `gpt/outbox/<JOB_ID>.md` and accepts one strict response at
`gpt/results/<JOB_ID>.json` through `gpt-submit`. Browser lane or conversation
identity is not part of correctness; there are no request, inbox, context, or
per-job schema artifacts.

The local P directory contains the immutable charter, addressed GPT
packets/results, WORK failure facts, and one addressed mechanical proof result
at `prove/results/<proof_id>.json`. A proof process that dies before publishing
that result is simply ABSENT on the next tick; partial manifests and proof-log
files are not workflow inputs. The default location is
`$XDG_STATE_HOME/yuvi-agentbus-v2`, or
`~/.local/state/yuvi-agentbus-v2`.

```bash
scripts/agentbus-v2 init P-ID \
  --charter /path/to/charter.md \
  --worktree /path/to/independent/worktree \
  --repository github.com/OWNER/REPO \
  --branch agentbus/p-id

scripts/agentbus-v2 tick P-ID
scripts/agentbus-v2 watch P-ID
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
without storing executor lifecycle state. `watch` polls at a bounded interval
and has no semantic no-progress policy.

Watched-resource fingerprints and not-before scheduling are deliberately
deferred for Experiment 1. A GPT `WAIT` therefore stops as `HUMAN` for manual
wake handling; it never creates a persisted workflow WAIT state.

## Browser GPT transport (7D.2A)

The separate v2 browser adapter is transport-only.  It binds a loopback bridge
at `127.0.0.1:6791` and exposes only `/bridge/config`, `/bridge/pull`,
`/bridge/claim`, `/bridge/heartbeat`, `/bridge/diagnostic`, and `/bridge/result`.
The bridge has memory-only pending requests and one ephemeral claim owner per
lane, so duplicate exact-conversation tabs cannot send the same live request.
No sent, generating, queue, or recovery files are written. Configure each browser lane
in `gpt_lanes.json` with `transport: "browser"`, an exact ChatGPT
`conversation_url`, and the same operational `bridge_token` (the token may be
top-level or repeated per lane).  The extension source is under
`tools/agentbus_v2/browser_extension/`; its `config.js` contains a placeholder
token and is not installed automatically.

The extension checks both fixed logical lanes, pulls only the lane bound to its
exact configured conversation, claims immediately before insertion, injects
only when the composer is empty and idle, and returns the new assistant message
as raw text.  Job-addressed operational diagnostics fence and expose the claim,
insertion, Send attempt, generation, response observation, and result relay
boundaries; a caller-supplied synchronous sink can journal them without making
them semantic authority.  After any operational lane failure the in-process
transport halts that lane instead of replaying the ambiguous job or starting its
next FIFO entry.  The extension can observe an exact current packet already in
the conversation and relay its following assistant response, but it never uses
conversation history as durable authority and never clicks Send twice after a
recorded attempt.  Response observation defaults to 900 seconds inside a
bounded 960-second adapter wait, leaving relay/ingestion margin. Automatic jobs
use a memory-only FIFO per lane, while PLAN and JUDGE lanes may run
independently. Manual packet/result submission remains a
first-class fallback. To perform a later 7D.2B canary, copy the configured
token into the extension's local `config.js`, load that directory as a
temporary unsigned Firefox extension, open the exact PLAN and JUDGE
conversation URLs, then enable the browser lanes. A Firefox restart may require
manually reloading this temporary development extension; durable pending facts
remain sufficient to resume after it is present again. No v1 bridge or browser
profile is modified by this phase.  Localhost bridge requests are delegated
from the content script to the extension background context, where the fixed
loopback host permission applies; the background handler exposes only the
listed transport endpoints and stores no semantic state.

## Signed v1 extension compatibility transport

The production browser option reuses the already signed v1 Firefox extension
as a legacy send-only client, while v2 remains the only kernel, scheduler,
WebUI, and semantic workflow. Run the v2 WebUI on its default loopback endpoint
`127.0.0.1:6738`; its read-only `GET /api/browser/jobs` projects only enabled
projects' freshly reconstructed exact `gpt_pending` identities into the wire
shape understood by that extension. No v1 campaign, stream phase, repair, PR,
or state directory is imported. A stale extension-local job that is absent
from the fresh v2 projection cannot recreate a v2 effect.

Create `legacy_v1_browser_compat.json` under the v2 state root as operational
configuration (do not commit conversation bindings):

```json
{
  "enabled": true,
  "conversations": {
    "plan": "https://chatgpt.com/c/EXACT_PLAN_CONVERSATION",
    "judge": "https://chatgpt.com/c/EXACT_JUDGE_CONVERSATION"
  },
  "mailboxes": {
    "github.com/OWNER/REPOSITORY": 123
  }
}
```

The projected prompt appends only a transport wrapper asking Web GPT to post
one exact, packet-hash-addressed envelope to the configured issue. Each browser
poll checks at most the most recent 100 comments on that one mailbox, rejects
wrong or duplicate identities, and passes the unmodified raw JSON through the
existing strict `submit_gpt_response` function. Comments are transport payloads,
not snapshot facts. Poll times, extension-online status, served-job hints, and
mailbox availability are memory-only WebUI diagnostics; restart reconstructs
the projection solely from v2 durable facts.
