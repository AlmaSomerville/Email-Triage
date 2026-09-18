-- Patch 02: attachments and events were stored as JSON strings containing JSON,
-- instead of as arrays. Unwrap them.

-- Look before you leap:
--   select jsonb_typeof(attachments) as t, count(*) from emails group by t;
-- 'string' rows are the broken ones. 'array' rows are already fine.

update emails
set attachments = (attachments #>> '{}')::jsonb
where jsonb_typeof(attachments) = 'string';

update emails
set events = (events #>> '{}')::jsonb
where events is not null and jsonb_typeof(events) = 'string';

-- Anything that still is not an array gets an empty one, so the app can rely on it.
update emails set attachments = '[]'::jsonb where jsonb_typeof(attachments) <> 'array';
update emails set events = '[]'::jsonb where events is null or jsonb_typeof(events) <> 'array';

-- Confirm: both should now report only 'array'.
--   select jsonb_typeof(attachments) a, jsonb_typeof(events) e, count(*) from emails group by a, e;
