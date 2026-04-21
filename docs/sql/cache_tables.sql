-- Vibe Editor — transcript cache (Supabase)
-- Run once in the Supabase SQL editor. The Node server uses the service role;
-- no RLS policies are required for anon/authenticated clients if only the server touches this table.

create table if not exists public.transcripts (
  audio_hash      text not null,
  language_hint   text not null default 'auto',
  transcript      jsonb not null,
  hit_count         integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz,
  primary key (audio_hash, language_hint)
);

create index if not exists transcripts_created_at_idx on public.transcripts (created_at desc);

comment on table public.transcripts is 'Whisper transcript cache keyed by SHA-256 of extracted audio bytes + language hint.';

alter table public.transcripts enable row level security;

-- Remotion render cache uses on-disk files under output/_render_cache/ (see src/cache/renderCache.js).
-- No Supabase table is required for render caching in the current implementation.
