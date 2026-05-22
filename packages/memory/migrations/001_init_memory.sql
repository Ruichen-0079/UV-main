create extension if not exists vector;
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create table if not exists memories (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('working', 'episodic', 'semantic', 'emotional', 'procedural', 'relationship')),
  subtype text null check (
    subtype is null or subtype in (
      'preference', 'fact', 'project', 'workflow', 'milestone',
      'provider-choice', 'path', 'repo', 'command', 'troubleshooting',
      'config', 'emotion', 'relationship'
    )
  ),
  scope text not null default 'user' check (scope in ('user', 'project', 'agent', 'plugin', 'session')),
  scope_id text null,
  memory_layer text not null default 'recall' check (memory_layer in ('core', 'recall', 'archival', 'working')),
  status text not null default 'active' check (status in ('active', 'superseded', 'archived', 'forgotten', 'expired')),
  content text not null,
  summary text null,
  embedding vector null,
  importance real not null default 0.5,
  emotion_valence real not null default 0,
  emotion_arousal real not null default 0,
  source text not null,
  source_trace_id text null,
  metadata jsonb not null default '{}'::jsonb,
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  observed_at timestamptz not null default now(),
  event_time timestamptz null,
  valid_from timestamptz not null default now(),
  valid_until timestamptz null,
  expires_at timestamptz null,
  last_accessed_at timestamptz not null default now(),
  superseded_at timestamptz null,
  supersedes text[] not null default '{}',
  superseded_by text null,
  contradicts text[] not null default '{}'
);

alter table memories add column if not exists subtype text null;
alter table memories add column if not exists scope text not null default 'user';
alter table memories add column if not exists scope_id text null;
alter table memories add column if not exists memory_layer text not null default 'recall';
alter table memories add column if not exists status text not null default 'active';
alter table memories add column if not exists source_trace_id text null;
alter table memories add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table memories add column if not exists observed_at timestamptz not null default now();
alter table memories add column if not exists event_time timestamptz null;
alter table memories add column if not exists valid_from timestamptz not null default now();
alter table memories add column if not exists valid_until timestamptz null;
alter table memories add column if not exists expires_at timestamptz null;
alter table memories add column if not exists superseded_at timestamptz null;
alter table memories add column if not exists supersedes text[] not null default '{}';
alter table memories add column if not exists superseded_by text null;
alter table memories add column if not exists contradicts text[] not null default '{}';
alter table memories drop constraint if exists memories_type_check;
alter table memories add constraint memories_type_check
  check (type in ('working', 'episodic', 'semantic', 'emotional', 'procedural', 'relationship'));
alter table memories drop constraint if exists memories_subtype_check;
alter table memories add constraint memories_subtype_check
  check (
    subtype is null or subtype in (
      'preference', 'fact', 'project', 'workflow', 'milestone',
      'provider-choice', 'path', 'repo', 'command', 'troubleshooting',
      'config', 'emotion', 'relationship'
    )
  );
alter table memories drop constraint if exists memories_scope_check;
alter table memories add constraint memories_scope_check
  check (scope in ('user', 'project', 'agent', 'plugin', 'session'));
alter table memories drop constraint if exists memories_memory_layer_check;
alter table memories add constraint memories_memory_layer_check
  check (memory_layer in ('core', 'recall', 'archival', 'working'));
alter table memories drop constraint if exists memories_status_check;
alter table memories add constraint memories_status_check
  check (status in ('active', 'superseded', 'archived', 'forgotten', 'expired'));

update memories
set memory_layer = case
  when type = 'working' then 'working'
  when type = 'semantic' then 'core'
  when subtype in ('preference', 'project', 'provider-choice') then 'core'
  when subtype in ('milestone', 'troubleshooting') then 'recall'
  when type = 'episodic' then 'recall'
  else memory_layer
end
where memory_layer = 'recall' or memory_layer is null;

update memories
set scope = 'project', scope_id = 'yuvi-runtime'
where scope = 'user'
  and scope_id is null
  and (
    content ilike '%yuvi%'
    or coalesce(summary, '') ilike '%yuvi%'
    or 'yuvi' = any(tags)
    or 'runtime' = any(tags)
  );

create table if not exists entities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null,
  created_at timestamptz not null default now()
);

create table if not exists relations (
  id uuid primary key default gen_random_uuid(),
  source_entity uuid not null references entities(id) on delete cascade,
  target_entity uuid not null references entities(id) on delete cascade,
  relation text not null,
  weight real not null default 1,
  created_at timestamptz not null default now()
);

create index if not exists memories_type_created_at_idx on memories (type, created_at desc);
create index if not exists memories_type_idx on memories (type);
create index if not exists memories_subtype_idx on memories (subtype);
create index if not exists memories_subtype_created_at_idx on memories (subtype, created_at desc);
create index if not exists memories_scope_scope_id_idx on memories (scope, scope_id);
create index if not exists memories_memory_layer_idx on memories (memory_layer);
create index if not exists memories_status_idx on memories (status);
create index if not exists memories_valid_from_idx on memories (valid_from desc);
create index if not exists memories_valid_until_idx on memories (valid_until);
create index if not exists memories_expires_at_idx on memories (expires_at);
create index if not exists memories_source_created_at_idx on memories (source, created_at desc);
create index if not exists memories_source_trace_id_idx on memories (source_trace_id);
create index if not exists memories_created_at_idx on memories (created_at desc);
create index if not exists memories_last_accessed_at_idx on memories (last_accessed_at desc);
create index if not exists memories_importance_created_at_idx on memories (importance desc, created_at desc);
create index if not exists memories_tags_idx on memories using gin (tags);
create index if not exists memories_content_trgm_idx on memories using gin (content gin_trgm_ops);
create index if not exists memories_summary_trgm_idx on memories using gin (summary gin_trgm_ops);
create index if not exists memories_source_trgm_idx on memories using gin (source gin_trgm_ops);
create index if not exists memories_metadata_idx on memories using gin (metadata);
create index if not exists entities_name_idx on entities (name);
create index if not exists relations_source_entity_idx on relations (source_entity);
create index if not exists relations_target_entity_idx on relations (target_entity);
