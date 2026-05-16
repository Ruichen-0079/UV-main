create extension if not exists vector;
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create table if not exists memories (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('working', 'episodic', 'semantic', 'emotional', 'procedural', 'relationship')),
  subtype text null check (
    subtype is null or subtype in (
      'preference', 'fact', 'project', 'workflow', 'milestone',
      'provider-choice', 'path', 'repo', 'command', 'emotion', 'relationship'
    )
  ),
  content text not null,
  summary text null,
  embedding vector null,
  importance real not null default 0.5,
  emotion_valence real not null default 0,
  emotion_arousal real not null default 0,
  source text not null,
  source_trace_id text null,
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_accessed_at timestamptz not null default now()
);

alter table memories add column if not exists subtype text null;
alter table memories add column if not exists source_trace_id text null;
alter table memories drop constraint if exists memories_type_check;
alter table memories add constraint memories_type_check
  check (type in ('working', 'episodic', 'semantic', 'emotional', 'procedural', 'relationship'));
alter table memories drop constraint if exists memories_subtype_check;
alter table memories add constraint memories_subtype_check
  check (
    subtype is null or subtype in (
      'preference', 'fact', 'project', 'workflow', 'milestone',
      'provider-choice', 'path', 'repo', 'command', 'emotion', 'relationship'
    )
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
create index if not exists memories_tags_idx on memories using gin (tags);
create index if not exists memories_content_trgm_idx on memories using gin (content gin_trgm_ops);
create index if not exists entities_name_idx on entities (name);
create index if not exists relations_source_entity_idx on relations (source_entity);
create index if not exists relations_target_entity_idx on relations (target_entity);
