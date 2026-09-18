/**
 * Triage pass. Reads messages with no category yet, asks Groq to classify them
 * and pull out any dates/times/places, writes the result back, repeats until
 * the queue is empty.
 *
 *   node enrich.js                 # drain the whole queue
 *   node enrich.js --rpm=25        # stay under Groq's free-tier rate limit
 *   node enrich.js --max=200       # stop after 200
 *
 * The model never counts anything and never decides what matched a search.
 * It only labels one message at a time. Counting is SQL's job.
 */
import 'dotenv/config';
import { sql } from './lib/db.js';

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=')[1] : d;
};

const RPM = Number(arg('rpm', 25));
const MAX = Number(arg('max', 0));
const MODEL = process.env.GROQ_TRIAGE_MODEL || 'llama-3.1-8b-instant';
const GAP = Math.ceil(60000 / RPM);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SYSTEM = `You label a single email from a high-conflict co-parenting inbox. The mail may be in Spanish or English.

Return JSON only, no prose, with exactly these keys:
{
  "category": one of "logistics" | "legal" | "hostile" | "fluff",
  "needs_reply": boolean,
  "events": [ { "date": "YYYY-MM-DD or null", "time": "HH:MM or null", "place": "string or null", "what": "short description" } ],
  "claims": [ "each factual assertion about the child, the home, health, money or schooling, quoted or closely paraphrased" ],
  "summary": "one neutral sentence, in English"
}

Definitions:
- logistics: handovers, dates, school, travel, practical arrangements.
- legal: solicitors, court, formal demands, anything referencing proceedings.
- hostile: insults, blame, pressure, accusations with no practical request.
- fluff: no action and no assertion of fact.

Rules: never infer a fact that is not written in the message. Leave "claims" empty if the message asserts nothing. Use null, never a guess, for a missing date.`;

async function classify(row) {
  const body = (row.body_text || '').slice(0, 6000);
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      max_tokens: 900,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: `From: ${row.from_name || ''} <${row.from_addr}>
Sent: ${new Date(row.sent_at).toISOString()}
Subject: ${row.subject || '(none)'}
Attachments: ${row.has_real_attachment ? JSON.stringify(row.attachments) : 'none'}

${body}`,
        },
      ],
    }),
  });

  if (res.status === 429) {
    const wait = Number(res.headers.get('retry-after') || 20);
    console.log(`  rate limited, waiting ${wait}s`);
    await sleep(wait * 1000);
    return classify(row);
  }
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

let done = 0;
for (;;) {
  const rows = await sql`
    select id, ref, from_addr, from_name, sent_at, subject, body_text,
           has_real_attachment, attachments
    from emails
    where enriched_at is null
    order by sent_at desc
    limit 20
  `;
  if (!rows.length) break;

  for (const row of rows) {
    if (MAX && done >= MAX) break;
    const started = Date.now();
    try {
      const out = await classify(row);
      const cat = ['logistics', 'legal', 'hostile', 'fluff'].includes(out.category)
        ? out.category
        : 'fluff';
      await sql`
        update emails set
          category = ${cat},
          events = ${JSON.stringify(out.events || [])},
          enriched_at = now()
        where id = ${row.id}
      `;
      console.log(`${row.ref}  ${cat.padEnd(9)} ${(out.summary || '').slice(0, 70)}`);
    } catch (e) {
      console.warn(`${row.ref}  failed: ${e.message}`);
      // Mark it done anyway so one bad message can't block the queue.
      await sql`update emails set category = 'fluff', enriched_at = now() where id = ${row.id}`;
    }
    done++;
    const spent = Date.now() - started;
    if (spent < GAP) await sleep(GAP - spent);
  }
  if (MAX && done >= MAX) break;
}

console.log(`Triaged ${done} message(s).`);
await sql.end();
