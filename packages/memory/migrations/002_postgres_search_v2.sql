create extension if not exists pg_trgm;

create index if not exists memories_scope_idx on memories (scope);
create index if not exists memories_scope_id_idx on memories (scope_id);
create index if not exists memories_scope_scope_id_status_idx on memories (scope, scope_id, status);
create index if not exists memories_memory_layer_status_idx on memories (memory_layer, status);
create index if not exists memories_status_created_at_idx on memories (status, created_at desc);
create index if not exists memories_type_subtype_idx on memories (type, subtype);
create index if not exists memories_source_idx on memories (source);
create index if not exists memories_updated_at_idx on memories (updated_at desc);
create index if not exists memories_importance_idx on memories (importance desc);
create index if not exists memories_observed_at_idx on memories (observed_at desc);
create index if not exists memories_source_trace_id_trgm_idx on memories using gin (source_trace_id gin_trgm_ops);
create index if not exists memories_scope_id_trgm_idx on memories using gin (scope_id gin_trgm_ops);
create index if not exists memories_type_trgm_idx on memories using gin (type gin_trgm_ops);
create index if not exists memories_subtype_trgm_idx on memories using gin (subtype gin_trgm_ops);
create index if not exists memories_memory_layer_trgm_idx on memories using gin (memory_layer gin_trgm_ops);

-- Keep this expression limited to immutable text columns. Tags and metadata are
-- covered by separate GIN indexes plus keyword search.
create index if not exists memories_search_tsv_idx on memories using gin (
  (
    setweight(to_tsvector('simple', coalesce(content, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(summary, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(type, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(subtype, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(scope, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(scope_id, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(memory_layer, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(source, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(source_trace_id, '')), 'C')
  )
);
