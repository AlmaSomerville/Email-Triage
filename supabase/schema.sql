-- Casefile schema. Paste this whole file into the Supabase SQL editor once.

create extension if not exists pg_trgm;
create extension if not exists unaccent;

-- unaccent() is STABLE, which Postgres refuses inside a generated column.
-- This immutable wrapper is the standard workaround.
create or replace function immutable_unaccent(text)
returns text language sql immutable strict parallel safe as
$$ select public.unaccent('public.unaccent', $1) $$;

create sequence if not exists email_ref_seq start 1000;

create table if not exists emails (
  id                  bigserial primary key,
  ref                 text unique not null default ('EMA-' || nextval('email_ref_seq')),
  message_id          text unique not null,          -- RFC822 Message-ID header
  imap_uid            bigint,
  folder              text not null default 'INBOX',
  from_addr           text not null,
  from_name           text,
  to_addrs            text[] default '{}',
  sent_at             timestamptz not null,
  subject             text,
  body_text           text,
  has_real_attachment boolean not null default false,
  attachments         jsonb   not null default '[]', -- [{filename,mime,bytes}]
  attachment_text     text,                          -- extracted PDF text
  category            text,                          -- logistics|legal|hostile|fluff
  events              jsonb default '[]',            -- [{date,time,place,what}]
  enriched_at         timestamptz,
  created_at          timestamptz not null default now(),

  snippet text generated always as (
    left(regexp_replace(coalesce(body_text,''), '\s+', ' ', 'g'), 300)
  ) stored,

  -- One index, both languages, accent-insensitive.
  tsv tsvector generated always as (
    to_tsvector('spanish', immutable_unaccent(
      coalesce(subject,'') || ' ' || coalesce(body_text,'') || ' ' || coalesce(attachment_text,'')))
    ||
    to_tsvector('english', immutable_unaccent(
      coalesce(subject,'') || ' ' || coalesce(body_text,'') || ' ' || coalesce(attachment_text,'')))
  ) stored
);

create index if not exists emails_tsv_idx    on emails using gin (tsv);
create index if not exists emails_sent_idx   on emails (sent_at desc);
create index if not exists emails_from_idx   on emails using gin (from_addr gin_trgm_ops);
create index if not exists emails_cat_idx    on emails (category);
create index if not exists emails_unenriched on emails (sent_at desc) where enriched_at is null;

create table if not exists tags (
  id serial primary key,
  name  text unique not null,
  color text not null default '#1F4E79',
  note  text
);

create table if not exists email_tags (
  email_id bigint references emails(id) on delete cascade,
  tag_id   int    references tags(id)   on delete cascade,
  added_at timestamptz not null default now(),
  primary key (email_id, tag_id)
);
create index if not exists email_tags_tag_idx on email_tags (tag_id);

-- Saved bilingual term lists. This is what makes recall reliable.
create table if not exists claim_terms (
  key   text primary key,
  label text not null,
  terms text[] not null
);

create table if not exists sync_state (
  folder       text primary key,
  last_uid     bigint not null default 0,
  uid_validity bigint,
  updated_at   timestamptz not null default now()
);

alter table emails      enable row level security;
alter table tags        enable row level security;
alter table email_tags  enable row level security;
alter table claim_terms enable row level security;
alter table sync_state  enable row level security;
-- No policies on purpose: anon and authenticated roles get nothing.
-- Only the server-side connection string can read or write.

-- ---------------------------------------------------------------
-- search_emails: filters, rows, and aggregates over the whole match set
-- ---------------------------------------------------------------
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

-- ---------------------------------------------------------------
-- Seed: bilingual claim vocabularies. Edit and extend freely.
-- ---------------------------------------------------------------
insert into claim_terms (key, label, terms) values
 ('damp',     'Damp or mould in the home',
   array['damp','mould','mold','humidity','leak','moho','humedad','hongos','goteras','filtracion','condensacion']),
 ('health',   'Chronic illness',
   array['chronic','ill','illness','cough','fever','asthma','doctor','medical','cronico','enfermo','enfermedad','tos','fiebre','asma','medico','pediatra','urgencias','receta','informe medico']),
 ('school',   'School and attendance',
   array['school','absence','term','teacher','escuela','colegio','falta','profesora','tutoria','matricula']),
 ('handover', 'Handover and logistics',
   array['pickup','drop off','handover','collect','recogida','entrega','llevar','recoger','horario']),
 ('money',    'Money and expenses',
   array['payment','invoice','expense','owe','transfer','pago','factura','gasto','deuda','transferencia','manutencion'])
on conflict (key) do nothing;

insert into tags (name, color, note) values
 ('Evidence',      '#2F5D50', 'Relevant to the file'),
 ('Unsupported',   '#7A2E2E', 'Claim made with nothing attached'),
 ('Contradiction', '#8A5A00', 'Conflicts with an earlier message'),
 ('Answered',      '#1F4E79', 'A reply has been sent')
on conflict (name) do nothing;
