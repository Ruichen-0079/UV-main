P_ID:
  P-V2-EXP1-WINDOWS-SHUTDOWN

GOAL:
  A genuine Windows close request to the YUVI main Tauri window must
  deterministically terminate the application and clean up only its owned
  Supervisor / Runtime / Mem0 processes within a bounded shutdown contract.

SCOPE:
  apps/desktop/src-tauri/**
  directly related focused packaging/smoke tests only when proven necessary

NON_GOALS:
  no P6 proactive code changes
  no AgentBus v1 changes
  no Browser Bridge changes
  no generic process-name killing
  no arbitrary timeout increase to hide the bug
  no unrelated desktop redesign
  no new shutdown lifecycle state machine

INVARIANTS:
  companion-window close semantics remain unchanged
  foreign processes are never killed
  owned process identity remains fenced
  shutdown is idempotent
  real product behavior must be fixed, not merely CI harness behavior

DEFINITION_OF_DONE:
  Windows packaged Tauri smoke proves:
    WM_CLOSE delivered
    Tauri exits
    Supervisor exits
    Runtime exits
    Mem0 exits
    no foreign process termination
    temp cleanup succeeds

  focused tests pass
  Rust checks/tests pass
  packaging tests pass
  git diff --check passes

  no arbitrary smoke timeout increase

  no P6 product HEAD change
