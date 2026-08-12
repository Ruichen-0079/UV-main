alter table conversation_messages
  add column if not exists source_user_event_id text null,
  add column if not exists finalized_turn_id text null,
  add column if not exists persona_id text null,
  add column if not exists subject_user_id text null,
  add column if not exists ingestion_requested boolean null,
  add column if not exists ingestion_skip_reason text null;

-- Identity backfill is deliberately separate from ingestion-completion
-- backfill. Historical assistant rows remain unknown (NULL decision) and are
-- discoverable for later reconciliation; they are never marked complete.
update conversation_messages
set finalized_turn_id = 'legacy:conversation:' || id
where role = 'assistant'
  and status = 'completed'
  and finalized_turn_id is null;

create unique index if not exists conversation_messages_finalized_turn_id_uidx
  on conversation_messages (finalized_turn_id)
  where finalized_turn_id is not null;

create index if not exists conversation_messages_ingestion_discovery_idx
  on conversation_messages (role, status, ingestion_requested, finalized_turn_id)
  where role = 'assistant' and status = 'completed';

create table if not exists finalized_ingestion_turns (
  finalized_turn_id text primary key,
  assistant_message_id text not null,
  source_user_event_id text null,
  conversation_id text not null,
  trace_id text not null,
  persona_id text null,
  subject_user_id text null,
  memory_scope text null,
  finalized_at timestamptz not null,
  ingestion_requested boolean not null,
  ingestion_skip_reason text null,
  failure_stage text null,
  status text not null check (status in (
    'pending', 'processing', 'complete', 'partial', 'retryable_failed',
    'reconcile_required', 'terminal_failed', 'skipped'
  )),
  policy_version text not null,
  source_digest text not null,
  eligible_event_count integer not null default 0,
  pending_event_count integer not null default 0,
  processing_event_count integer not null default 0,
  complete_event_count integer not null default 0,
  unchanged_event_count integer not null default 0,
  failed_event_count integer not null default 0,
  ambiguous_event_count integer not null default 0,
  skipped_event_count integer not null default 0,
  attempt_count integer not null default 0,
  last_attempt_at timestamptz null,
  next_attempt_at timestamptz null,
  completed_at timestamptz null,
  last_error_code text null,
  last_error_message text null,
  lease_owner text null,
  lease_expires_at timestamptz null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (assistant_message_id, finalized_turn_id)
);

alter table finalized_ingestion_turns
  add column if not exists failure_stage text null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'finalized_ingestion_turns'::regclass
      and conname = 'finalized_ingestion_turns_failure_stage_ck'
  ) then
    alter table finalized_ingestion_turns
      add constraint finalized_ingestion_turns_failure_stage_ck
      check (failure_stage is null or failure_stage in ('materialization'));
  end if;
end $$;

create index if not exists finalized_ingestion_turns_status_idx
  on finalized_ingestion_turns (status, next_attempt_at, updated_at);
create index if not exists finalized_ingestion_turns_conversation_idx
  on finalized_ingestion_turns (conversation_id, finalized_at desc);
create index if not exists finalized_ingestion_turns_assistant_idx
  on finalized_ingestion_turns (assistant_message_id);

create table if not exists finalized_ingestion_events (
  event_id text primary key,
  finalized_turn_id text not null references finalized_ingestion_turns(finalized_turn_id) on delete cascade,
  event_key text not null,
  backend_idempotency_key text not null,
  event_payload jsonb not null,
  status text not null check (status in (
    'pending', 'processing', 'complete', 'unchanged', 'retryable_failed',
    'reconcile_required', 'terminal_failed', 'skipped'
  )),
  result_kind text null check (result_kind is null or result_kind in (
    'written', 'unchanged', 'rejected', 'ambiguous', 'skipped'
  )),
  attempt_count integer not null default 0,
  last_attempt_at timestamptz null,
  next_attempt_at timestamptz null,
  backend_memory_id text null,
  backend_operation text null,
  error_code text null,
  error_message text null,
  lease_owner text null,
  lease_expires_at timestamptz null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (finalized_turn_id, event_key),
  unique (backend_idempotency_key)
);

create index if not exists finalized_ingestion_events_turn_status_idx
  on finalized_ingestion_events (finalized_turn_id, status, next_attempt_at);
create index if not exists finalized_ingestion_events_retry_idx
  on finalized_ingestion_events (status, next_attempt_at, updated_at);
