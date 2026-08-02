create table if not exists conversation_sessions (
  id text primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists conversation_messages (
  id text primary key,
  session_id text not null references conversation_sessions(id) on delete cascade,
  trace_id text not null,
  parent_message_id text null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  status text not null check (status in ('completed', 'failed')),
  created_at timestamptz not null,
  completed_at timestamptz null,
  metadata jsonb not null default '{}'::jsonb,
  sequence bigserial not null
);

create index if not exists conversation_messages_session_sequence_idx
  on conversation_messages (session_id, sequence);
create index if not exists conversation_messages_session_created_at_idx
  on conversation_messages (session_id, created_at);
