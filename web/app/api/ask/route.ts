import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * The model is handed rows and counts that Postgres already worked out.
 * It is told, explicitly, not to produce a number of its own. Everything
 * it says has to point at a REF code that was in its input.
 */
const SYSTEM = `You write findings for a case file, from email records supplied to you.

You are given: a question, the file owner's own email address, a set of matched
email records, and a COUNTS block computed by the database.

Attribution comes first. Each record is marked SENT BY OWNER or RECEIVED. Never
state who said something unless the record's marking tells you. Name the sender in
every timeline entry.

What a record proves. A message SENT BY OWNER proves the owner asserted something
on that date. It does not establish that the thing asserted is true. Write "the
owner stated that X", never "X happened". The same holds for received messages:
they show what the other party claimed, not what occurred.

Hard rules:
- Every number you state must be copied from the COUNTS block. Never count anything
  yourself, and never write "several" or "repeatedly" in place of a figure.
- Every assertion must cite the REF codes it rests on, as [EMA-1234].
- If the records do not answer the question, say exactly that. Do not fill the gap.
- Never describe anyone's motive, character or state of mind.
- Messages may be in Spanish. Quote the original, then a short English rendering in
  brackets.

The reply draft answers the single most recent RECEIVED message, not the whole set.
If every record was sent by the owner, return an empty string for it.

Return JSON only:
{
  "finding": "2-5 sentences. Plain, neutral, cited, attributed.",
  "timeline": [ { "ref": "EMA-1234", "date": "YYYY-MM-DD", "sender": "owner or the sender's name", "what": "one short line" } ],
  "evidence_note": "one sentence on what was or was not attached, using the COUNTS figures",
  "reply_draft": "At most two sentences. Brief, firm, factual, friendly. No questions unless one is logistically required. No history, no adjectives about the other person, no defensiveness."
}`;

/** Pulls the first {...} out of a reply that arrived wrapped in prose or fences. */
function salvageJson(text: string | undefined) {
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

export async function POST(req: Request) {
  try {
    const { question, rows, stats } = await req.json();
    const owner = (process.env.OWNER_EMAIL || '').toLowerCase().trim();

    if (!process.env.GROQ_API_KEY) {
      return NextResponse.json({ error: 'GROQ_API_KEY is not set on the server.' }, { status: 503 });
    }
    if (!rows?.length) {
      return NextResponse.json({ error: 'No records matched, so there is nothing to summarise.' }, { status: 400 });
    }

    const counts = [
      `Matched messages: ${stats.total}`,
      `With a document attached: ${stats.withAttachment}`,
      `Without any attachment: ${stats.total - stats.withAttachment}`,
      `Earliest: ${stats.firstSent ? String(stats.firstSent).slice(0, 10) : 'n/a'}`,
      `Latest: ${stats.lastSent ? String(stats.lastSent).slice(0, 10) : 'n/a'}`,
    ].join('\n');

    const records = rows
      .slice(0, 60)
      .map(
        (r: any) =>
          `[${r.ref}] ${String(r.sentAt).slice(0, 10)}
${owner && r.fromAddr?.toLowerCase() === owner ? 'SENT BY OWNER' : 'RECEIVED'} — from ${r.fromAddr}
subject: ${r.subject || '(none)'}
attached: ${r.hasAttachment ? r.attachments.map((a: any) => a.filename).join(', ') : 'nothing'}
text: ${(r.snippet || '').slice(0, 400)}`
      )
      .join('\n\n');

    const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
    const messages = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `QUESTION\n${question}\n\nFILE OWNER\n${owner || 'not configured — mark every attribution as unknown'}\n\nCOUNTS\n${counts}\n\nRECORDS\n${records}` },
    ];

    // Two goes: strict JSON, then plain text with the object salvaged out of it.
    // Reasoning models spend their budget thinking and can return empty content
    // under strict JSON mode, which surfaces as a 400 with no explanation.
    let lastDetail = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      const payload: any = {
        model,
        temperature: 0.1,
        max_tokens: 1600,
        messages,
      };
      if (attempt === 1) payload.response_format = { type: 'json_object' };
      if (/gpt-oss|reason|qwq|deepseek-r/i.test(model)) payload.reasoning_effort = 'low';

      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify(payload),
      });

      const text = await res.text();
      if (!res.ok) {
        lastDetail = `Groq returned ${res.status}. ${text.slice(0, 220)}`;
        // A missing model will never succeed on a retry.
        if (res.status === 404 || res.status === 401) break;
        continue;
      }

      const parsed = salvageJson(JSON.parse(text).choices?.[0]?.message?.content);
      if (parsed) return NextResponse.json(parsed);
      lastDetail = 'The model replied, but not with anything readable.';
    }

    return NextResponse.json({ error: lastDetail }, { status: 502 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
