create extension if not exists vector;

alter table memories add column if not exists embedding vector null;
alter table memories add column if not exists embedding_model text null;
alter table memories add column if not exists embedding_provider text null;
alter table memories add column if not exists embedding_dimensions integer null;
alter table memories add column if not exists embedded_at timestamptz null;

create index if not exists memories_embedding_provider_model_idx
  on memories (embedding_provider, embedding_model);
create index if not exists memories_embedding_dimensions_idx
  on memories (embedding_dimensions);
create index if not exists memories_embedded_at_idx
  on memories (embedded_at desc);
