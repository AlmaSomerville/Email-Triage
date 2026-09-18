-- Patch 01: track triage attempts, and undo the labels that were guessed
-- after a Groq failure rather than actually decided.

alter table emails add column if not exists enrich_attempts int not null default 0;

create index if not exists emails_unenriched_v2
  on emails (sent_at desc)
  where enriched_at is null;

-- Any message labelled 'fluff' that has no summary and no events is very likely
-- one the old script gave up on. Put them back in the queue.
-- Check the count first:
--   select count(*) from emails where category = 'fluff' and events = '[]'::jsonb;

update emails
set category = null, enriched_at = null, enrich_attempts = 0
where category = 'fluff'
  and coalesce(events, '[]'::jsonb) = '[]'::jsonb;
