# Casefile

A private, searchable record of an email correspondence. Pulls mail over IMAP into
Postgres, triages it, and lets you search it in two languages with filters, labels
and reference codes.

Three pieces:

| Piece | Where it runs | What it does |
|---|---|---|
| `supabase/schema.sql` | Supabase, once | Tables, bilingual search index, the search function |
| `worker/` | Your laptop, on demand | Pulls mail in, triages it with Groq |
| `web/` | Vercel | The interface |

The workers run on your machine, not on Vercel. Serverless functions time out long
before a mailbox backfill finishes, and a laptop running a script for twenty minutes
costs nothing.

---

## 1. Database

Create a free Supabase project. Open the SQL editor, paste the whole of
`supabase/schema.sql`, run it.

Then copy the connection string from **Project Settings → Database → Connection
string → Transaction pooler**. You need it twice, in both `.env` files.

Row-level security is on with no policies, so the public anon key can read nothing.
Only the connection string works, and it never reaches the browser.

## 2. Gmail app password

Google Account → Security → 2-Step Verification → App passwords. Generate one for
"Mail". It is sixteen characters. This avoids OAuth verification entirely, which for
`gmail.readonly` would otherwise mean a paid third-party security assessment.

## 3. Pull the mail in

```bash
cd worker
cp .env.example .env        # fill it in
npm install

npm run ingest              # new mail in the inbox
npm run backfill            # everything, sent mail included
```

The backfill is resumable. Stop it with Ctrl-C and run it again; it picks up from the
last message it stored. On a few thousand messages expect a few minutes.

Useful flags:

```bash
node ingest.js --since=2024-01-01          # how far back on a first run
node ingest.js --max=200                   # stop after 200, to try it out
node ingest.js --loop=300                  # keep checking every five minutes
```

## 4. Triage it

```bash
npm run enrich
```

This is the only rate-limited step. It labels each message as logistics, legal,
hostile or fluff, and pulls out any dates and places. It drains the queue and stops.
Run it again whenever new mail lands. `--rpm=25` keeps it inside Groq's free tier;
that is roughly 1,500 messages an hour.

If Groq is down or a message is malformed, that message is marked done and skipped
rather than blocking everything behind it.

## 5. The interface

```bash
cd web
cp .env.example .env.local  # fill it in
npm install
npm run dev
```

Deploy with `vercel`, then set `DATABASE_URL`, `GROQ_API_KEY` and `APP_PASSWORD` in
the Vercel project settings. Without `APP_PASSWORD` the app returns 503 and serves
nothing — that is deliberate.

---

## How search works

Type `damp` and it also searches `moho`, `humedad`, `hongos`, `goteras`,
`filtracion`, `condensacion`. Accents are ignored, so `cronico` finds `crónico`.
Both Spanish and English stemming are applied, so `enfermedad` finds `enfermo`.

Those word lists live in the `claim_terms` table. Add your own:

```sql
insert into claim_terms (key, label, terms) values
  ('travel', 'Travel and passports',
   array['passport','flight','travel','pasaporte','vuelo','viaje','autorizacion']);
```

The line under the counts shows every word that was actually searched, so you can
always see why something matched.

## Counts come from the database, not the model

The figures in the heading — how many messages, over what dates, how many had
something attached — are SQL aggregates. The model is handed those numbers and told
to copy them. It is not asked to count, and it is told to cite a `[EMA-####]` code
for anything it asserts.

This matters more than it sounds. A model that quietly recounts four as three, in a
document you rely on, is worse than no tool at all.

## Attachments

`has_real_attachment` ignores inline images, so a signature logo does not register as
a document. PDF text is extracted and indexed, so a search for `informe medico` will
find it inside an attached report, not only in the body.

## Reference codes

Every message gets a permanent code on the way in — `EMA-2735`, and so on. They never
change and never get reused. Click one to copy it. "Copy the reference list" gives you:

```
[REF# EMA-2735] 2026-08-17 | Lunes 21, escuela
[REF# EMA-2739] 2026-08-17 | Lunes 21, escuela
```

"Open in Gmail" searches by the message's `Message-ID` header, which survives
archiving, relabelling and moving between folders — unlike a Gmail URL id.

---

## Worth knowing

**The emails are the evidence, not this app.** Treat everything here as a way of
finding and citing the originals. Anything you rely on should be checked against the
message in Gmail, which is what the reference codes and deep links are for. Keep a
plain `.mbox` export of the mailbox as well; it is the format anyone else will ask
for.

**The password gate is one shared password.** Adequate for one person; not something
to hand around.

**WhatsApp, later.** It fits the same shape: one more row source writing into
`emails` with a different `folder` value, and the whole search, labelling and
reference system works unchanged. Worth doing after this has been running a while.
