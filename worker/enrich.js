/**
 * Triage pass. Reads messages with no category yet, asks Groq to classify them
 * and pull out any dates/times/places, writes the result back, repeats until
 * the queue is empty.
 *
 *   node enrich.js                 # drain the queue
 *   node enrich.js --rpm=25        # stay inside Groq's free-tier rate limit
 *   node enrich.js --max=200       # stop after 200
 *   node enrich.js --retry         # try the ones that failed before, again
 *
 * A message that fails three times is left unlabelled rather than guessed at.
 * Nothing is ever marked 'fluff' because the model fell over.
 */
import 'dotenv/config';
import { sql } from './lib/db.js';

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=')[1] : d;
};
const flag = (n) => process.argv.includes(`--${n}`);

const RPM = Number(arg('rpm', 25));
const MAX = Number(arg('max', 0));
const MODEL = process.env.GROQ_TRIAGE_MODEL || 'llama-3.1-8b-instant';
const GAP = Math.ceil(60000 / RPM);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OWNER = (process.env.OWNER_EMAIL || '').toLowerCase().trim();

const SYSTEM = `You label one message from a co-parenting correspondence. It may be in Spanish or English.

The message is marked SENT BY OWNER or RECEIVED. A message sent by the owner records
what the owner asserted; a received one records what the other party asserted. Neither
establishes that the thing asserted is true. Never treat either as fact.

Reply with one JSON object and nothing else, in exactly this shape:

{"topics":["handover","schooling"],"tone":"practical","needs_reply":true,"deadline":"2026-10-31","events":[{"date":"2026-10-31","time":"09:00","place":"school gate","what":"collection"}],"flags":{"allegation":false,"cites_agreement":true,"names_professional":false,"money_demand":false},"summary":"one neutral sentence in English naming who said what"}

topics: any that apply, from handover, schooling, health, money, travel, contact,
legal_process, other. "contact" is about calls and messaging itself. "legal_process"
means solicitors, court, formal demands or prescribed procedure.

tone: exactly one of
- practical: a request, an arrangement, or information
- allegation: asserts something about the child, the home, health, money or conduct
- hostile: blame, insult or pressure, with no practical request
- formal: written in legal register, or reserving or asserting rights

deadline: a date by which something must be done, if one is stated. Otherwise null.
Never infer a deadline from a date merely mentioned.

flags:
- allegation: asserts a disputable fact about the child, the home, health or conduct
- cites_agreement: refers to the convenio, court order, or an agreed arrangement
- names_professional: names a doctor, teacher, solicitor, police or other authority
- money_demand: asks for, or disputes, a payment

summary: under 22 words, naming the sender as "the owner" or by name. Never guess a
date. Use null, not a guess, for anything not stated.`;

/** Pulls the first {...} out of a reply that arrived wrapped in prose or fences. */
function salvageJson(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function callGroq(row, attempt) {
  // 1: strict JSON mode.
  // 2: same but warmer and shorter — temperature 0 makes small models loop and
  //    emit nothing at all, which is what a 400 with an empty failed_generation is.
  // 3: no JSON mode, salvage the object out of whatever came back.
  const strict = attempt < 3;
  const body = (row.body_text || '').slice(0, attempt === 1 ? 5000 : 2500);

  const payload = {
    model: MODEL,
    temperature: attempt === 1 ? 0.1 : 0.4,
    max_tokens: 800,
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `${OWNER && (row.from_addr || '').toLowerCase() === OWNER ? 'SENT BY OWNER' : 'RECEIVED'}
From: ${row.from_name || ''} <${row.from_addr}>
Sent: ${new Date(row.sent_at).toISOString()}
Subject: ${row.subject || '(none)'}
Attachments: ${row.has_real_attachment ? JSON.stringify(row.attachments) : 'none'}

${body || '(empty message)'}`,
      },
    ],
  };
  if (strict) payload.response_format = { type: 'json_object' };

  // Reasoning models spend their output budget thinking and can hand back an
  // empty content field, which is what an empty failed_generation looks like.
  // Turning the reasoning down keeps the answer in the visible reply.
  if (/gpt-oss|reason|qwq|deepseek-r/i.test(MODEL)) payload.reasoning_effort = 'low';

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (res.status === 429) {
    const wait = Number(res.headers.get('retry-after') || 20);
    console.log(`  rate limited, waiting ${wait}s`);
    await sleep(wait * 1000);
    return callGroq(row, attempt);
  }

  const text = await res.text();
  if (!res.ok) throw new Error(`Groq ${res.status}: ${text.slice(0, 140)}`);

  const data = JSON.parse(text);
  const parsed = salvageJson(data.choices?.[0]?.message?.content);
  if (!parsed) throw new Error('no JSON object in the reply');
  return parsed;
}

const TOPICS = ['handover', 'schooling', 'health', 'money', 'travel', 'contact', 'legal_process', 'other'];
const TONES = ['practical', 'allegation', 'hostile', 'formal'];

async function classifyOnce(row, attempt) {
  const out = await callGroq(row, attempt);
  const tone = TONES.includes(out.tone) ? out.tone : null;
  if (!tone) throw new Error(`unusable tone: ${JSON.stringify(out.tone)}`);

  const topics = (Array.isArray(out.topics) ? out.topics : []).filter((t) => TOPICS.includes(t));
  const flags = {
    allegation: !!out.flags?.allegation,
    cites_agreement: !!out.flags?.cites_agreement,
    names_professional: !!out.flags?.names_professional,
    money_demand: !!out.flags?.money_demand,
    needs_reply: !!out.needs_reply,
  };
  const deadline = /^\d{4}-\d{2}-\d{2}$/.test(out.deadline || '') ? out.deadline : null;

  return {
    cat: tone,
    topics: topics.length ? topics : ['other'],
    flags,
    deadline,
    events: Array.isArray(out.events) ? out.events : [],
    summary: out.summary || '',
  };
}

async function classify(row) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await classifyOnce(row, attempt);
    } catch (e) {
      last = e;
      if (attempt < 3) await sleep(1200);
    }
  }
  throw last;
}

// ---------------------------------------------------------------

if (flag('retry')) {
  const r = await sql`update emails set enrich_attempts = 0 where enriched_at is null`;
  console.log(`Reset ${r.count} message(s) for another go.\n`);
}

let done = 0;
let failed = 0;

for (;;) {
  const rows = await sql`
    select id, ref, from_addr, from_name, sent_at, subject, body_text,
           has_real_attachment, attachments
    from emails
    where enriched_at is null and enrich_attempts < 3
    order by sent_at desc
    limit 20
  `;
  if (!rows.length) break;

  for (const row of rows) {
    if (MAX && done >= MAX) break;
    const started = Date.now();
    try {
      const { cat, topics, flags, deadline, events, summary } = await classify(row);
      await sql`
        update emails set
          category = ${cat},
          topics = ${topics},
          flags = ${sql.json(flags)},
          deadline = ${deadline},
          events = ${sql.json(events)},
          enriched_at = now(),
          enrich_attempts = enrich_attempts + 1
        where id = ${row.id}
      `;
      const mark = deadline ? ` due ${deadline}` : '';
      console.log(`${row.ref}  ${cat.padEnd(10)} ${topics.join('/').padEnd(18)} ${summary.slice(0, 52)}${mark}`);
    } catch (e) {
      failed++;
      // Left unlabelled on purpose. A wrong label is worse than none: it would
      // hide the message from the hostile and legal views without telling you.
      await sql`update emails set enrich_attempts = enrich_attempts + 1 where id = ${row.id}`;
      console.warn(`${row.ref}  unlabelled: ${e.message}`);
    }
    done++;
    const spent = Date.now() - started;
    if (spent < GAP) await sleep(GAP - spent);
  }
  if (MAX && done >= MAX) break;
}

const [{ stuck }] = await sql`
  select count(*)::int as stuck from emails where enriched_at is null and enrich_attempts >= 3
`;

console.log(`\nProcessed ${done}. ${failed} could not be labelled this run.`);
if (stuck) console.log(`${stuck} still unlabelled after three tries. Run: node enrich.js --retry`);
await sql.end();
