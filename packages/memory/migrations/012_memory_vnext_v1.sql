-- Memory vNext L1 recent episodes and dream consolidation jobs.
-- These tables are Yuvi-owned context/work ledgers. They are not a second
-- MemoryEvent authority and do not replace Mem0 or the finalized ingestion ledger.

create table if not exists recent_episodes (
  episode_id text primary key check (length(episode_id) between 1 and 200),
  session_id text not null check (length(session_id) between 1 and 200),
  persona_id text null check (persona_id is null or length(persona_id) between 1 and 200),
  subject_user_id text null check (
    subject_user_id is null or length(subject_user_id) between 1 and 200
  ),
  memory_scope text null check (memory_scope is null or length(memory_scope) between 1 and 400),
  started_at timestamptz not null,
  ended_at timestamptz not null,
  recorded_at timestamptz not null,
  occurred_at timestamptz null,
  temporal_confidence text not null check (
    temporal_confidence in ('high', 'medium', 'low', 'unknown')
  ),
  status text not null check (
    status in ('active', 'rolled', 'consolidating', 'consolidated', 'expired')
  ),
  source_turn_ids jsonb not null,
  source_digest text not null check (length(source_digest) = 64),
  what_happened text not null,
  user_statements jsonb not null,
  task_state text null,
  unresolved text null,
  outcome text null,
  assistant_context text null,
  metadata jsonb not null default '{}'::jsonb,
  recurrence_count integer not null default 0,
  last_accessed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consolidated_at timestamptz null,
  consolidation_job_id text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_digest)
);

create index if not exists recent_episodes_identity_ended_idx
  on recent_episodes (subject_user_id, persona_id, ended_at desc);
create index if not exists recent_episodes_session_ended_idx
  on recent_episodes (session_id, ended_at desc);
create index if not exists recent_episodes_status_expires_idx
  on recent_episodes (status, expires_at);

create table if not exists dream_jobs (
  job_id text primary key check (length(job_id) between 1 and 200),
  trigger_kind text not null check (
    trigger_kind in ('recurrence', 'salience', 'explicit', 'idle', 'scheduled')
  ),
  status text not null check (
    status in (
      'pending', 'processing', 'complete', 'skipped', 'terminal_failed', 'reconcile_required'
    )
  ),
  memory_scope text null,
  persona_id text null,
  subject_user_id text null,
  source_episode_ids jsonb not null,
  source_digest text not null check (length(source_digest) = 64),
  payload jsonb not null default '{}'::jsonb,
  result_event_payloads jsonb null,
  result_summary text null,
  attempt_count integer not null default 0,
  lease_owner text null,
  lease_expires_at timestamptz null,
  last_error_code text null,
  last_error_message text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz null,
  unique (source_digest)
);

create index if not exists dream_jobs_status_created_idx
  on dream_jobs (status, created_at);
