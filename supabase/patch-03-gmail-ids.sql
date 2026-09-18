-- Patch 03: store Gmail's own message id so links open the message directly
-- instead of running an rfc822msgid: search, which fails on many ids.

alter table emails add column if not exists gm_msgid text;
alter table emails add column if not exists gm_thrid text;

-- Re-fetch the mailbox so the new columns fill in. Nothing is duplicated:
-- messages are keyed on message_id and simply get updated in place.
update sync_state set last_uid = 0;

-- The search function must hand back the new column and the message body.
-- Its return type changes, so it has to be dropped rather than replaced.
drop function if exists search_emails(text[], text, date, date, int[], text[], boolean, int, int);

create or replace function search_emails(
  p_terms          text[]  default null,
  p_from           text    default null,
  p_date_from      date    default null,
  p_date_to        date    default null,
  p_tags           int[]   default null,
  p_categories     text[]  default null,
  p_has_attachment boolean default null,
  p_limit          int     default 50,
  p_offset         int     default 0
)
returns table (
  id bigint, ref text, message_id text, sent_at timestamptz,
  from_addr text, from_name text, subject text, snippet text,
  has_real_attachment boolean, attachments jsonb, category text, body_text text, gm_msgid text,
  events jsonb, tags jsonb, rank real,
  total_count bigint, first_sent timestamptz, last_sent timestamptz, with_attachment bigint
)
language plpgsql stable as $fn$
declare
  q  tsquery := null;
  qe tsquery;
  t  text;
begin
  if p_terms is not null then
    foreach t in array p_terms loop
      qe := plainto_tsquery('spanish', immutable_unaccent(t));
      if numnode(qe) > 0 then q := case when q is null then qe else q || qe end; end if;
      qe := plainto_tsquery('english', immutable_unaccent(t));
      if numnode(qe) > 0 then q := case when q is null then qe else q || qe end; end if;
    end loop;
  end if;

  return query
  with matched as (
    select e.*, (case when q is null then 0 else ts_rank(e.tsv, q) end)::real as r
    from emails e
    where (q is null or e.tsv @@ q)
      and (p_from is null or e.from_addr ilike '%' || p_from || '%')
      and (p_date_from is null or e.sent_at >= p_date_from)
      and (p_date_to   is null or e.sent_at <  (p_date_to + 1))
      and (p_categories is null or e.category = any(p_categories))
      and (p_has_attachment is null or e.has_real_attachment = p_has_attachment)
      and (p_tags is null or exists (
            select 1 from email_tags et
            where et.email_id = e.id and et.tag_id = any(p_tags)))
  ),
  agg as (
    select count(*) c, min(m.sent_at) f, max(m.sent_at) l,
           count(*) filter (where m.has_real_attachment) w
    from matched m
  )
  select m.id, m.ref, m.message_id, m.sent_at, m.from_addr, m.from_name,
         m.subject, m.snippet, m.has_real_attachment, m.attachments,
         m.category, m.body_text, m.gm_msgid, m.events,
         coalesce((select jsonb_agg(jsonb_build_object('id', tg.id, 'name', tg.name, 'color', tg.color)
                                    order by tg.name)
                   from email_tags et join tags tg on tg.id = et.tag_id
                   where et.email_id = m.id), '[]'::jsonb),
         m.r, a.c, a.f, a.l, a.w
  from matched m cross join agg a
  order by m.sent_at desc
  limit p_limit offset p_offset;
end $fn$;

