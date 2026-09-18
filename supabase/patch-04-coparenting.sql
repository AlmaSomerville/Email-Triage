-- Patch 04: a taxonomy that fits co-parenting, plus recipient and direction filters.

alter table emails add column if not exists topics   text[] not null default '{}';
alter table emails add column if not exists flags    jsonb  not null default '{}';
alter table emails add column if not exists deadline date;

create index if not exists emails_topics_idx on emails using gin (topics);
create index if not exists emails_flags_idx  on emails using gin (flags);
create index if not exists emails_to_idx     on emails using gin (to_addrs);
create index if not exists emails_deadline_idx on emails (deadline) where deadline is not null;

-- Labels worth having on a file like this. The old four stay if you use them.
insert into tags (name, color, note) values
 ('Needs a reply',    '#8A5A00', 'Waiting on you'),
 ('Deadline',         '#8C2F2F', 'Something is due'),
 ('For the solicitor','#14538A', 'Send this on'),
 ('No evidence given','#8C2F2F', 'A claim with nothing attached'),
 ('Contradicts',      '#8A5A00', 'Conflicts with an earlier message'),
 ('Cites the order',  '#2C6151', 'References the agreement or court order'),
 ('Keep for court',   '#2C6151', 'Bundle this'),
 ('Settled',          '#78868F', 'Dealt with, no action left')
on conflict (name) do nothing;

-- Everything already triaged predates the new fields, so triage it again.
update emails set enriched_at = null, enrich_attempts = 0;

-- The search function gains recipient, direction, topic and flag filters.
drop function if exists search_emails(text[], text, date, date, int[], text[], boolean, int, int);

create or replace function search_emails(
  p_terms          text[]  default null,
  p_from           text    default null,
  p_to             text    default null,
  p_owner          text    default null,
  p_direction      text    default null,   -- 'sent' | 'received' | null
  p_topics         text[]  default null,
  p_flag           text    default null,   -- a key in the flags object that must be true
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
  topics text[], flags jsonb, deadline date, to_addrs text[],
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
      and (p_to is null or exists (
            select 1 from unnest(e.to_addrs) a where a ilike '%' || p_to || '%'))
      and (p_direction is null or p_owner is null or
           (p_direction = 'sent'     and lower(e.from_addr) = lower(p_owner)) or
           (p_direction = 'received' and lower(e.from_addr) <> lower(p_owner)))
      and (p_topics is null or e.topics && p_topics)
      and (p_flag is null or coalesce((e.flags ->> p_flag)::boolean, false))
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
         m.category, m.body_text, m.gm_msgid,
         m.topics, m.flags, m.deadline, m.to_addrs, m.events,
         coalesce((select jsonb_agg(jsonb_build_object('id', tg.id, 'name', tg.name, 'color', tg.color)
                                    order by tg.name)
                   from email_tags et join tags tg on tg.id = et.tag_id
                   where et.email_id = m.id), '[]'::jsonb),
         m.r, a.c, a.f, a.l, a.w
  from matched m cross join agg a
  order by m.sent_at desc
  limit p_limit offset p_offset;
end $fn$;

