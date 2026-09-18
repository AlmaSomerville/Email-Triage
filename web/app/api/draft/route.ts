import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Drafts replies to one message. Three strategies rather than one, because the
 * right move varies: sometimes you answer the logistics and ignore the rest,
 * sometimes you need the refusal on the record.
 */
const SYSTEM = `You draft replies in a high-conflict co-parenting correspondence. The other party may forward anything you write to a solicitor or a court, so everything must read well in that setting.

Write to these rules, which are what BIFF means in practice:

Brief. Two to four sentences. One short paragraph. Longer replies invite longer replies.
Informative. Give the facts that are needed and nothing else: a date, a time, a place, a yes or a no. Concrete beats general — "Friday 3 October at 4pm at the school gate", not "later this week".
Friendly. Neutral and civil throughout. No warmth that isn't meant, no coldness either.
Firm. End the exchange. Do not open a topic, do not invite a discussion, do not ask a question unless an arrangement genuinely cannot proceed without the answer.

Never do any of these:
- Justify, argue, defend or explain yourself. No "as I have said before", no "the reason I", no recounting of history.
- Characterise the other person or their motives, or use any adjective about them.
- Respond to provocation, accusation or insult. Answer only the practical content. If there is none, the reply is a short acknowledgement or nothing at all.
- Assert a fact that is not in the material given to you. Never invent a date, a time, an amount or an arrangement. If a specific is needed and you do not have it, write it as [date] or [time] for the owner to fill in.
- Threaten, or mention legal consequences, unless the material shows the owner has already said it.

When the incoming message makes an allegation with nothing attached, the strongest move is usually to note what would resolve it, once, without argument: "If there is a medical report, please send it and I will take it into account."

Reply in the language the incoming message was written in. If it is Spanish, write Spanish, using usted unless the surrounding correspondence is clearly informal.

Return JSON only:
{
  "incoming_summary": "one neutral sentence: what this message actually asks for or asserts",
  "needs_reply": true,
  "no_reply_rationale": "if needs_reply is false, one sentence on why silence is the better option; otherwise empty",
  "drafts": [
    { "label": "Answer the practical part", "body": "..." },
    { "label": "Answer and put the gap on the record", "body": "..." },
    { "label": "Short acknowledgement", "body": "..." }
  ]
}

The three drafts must genuinely differ in strategy, not merely in wording. If only one approach makes sense, return one draft and say so in incoming_summary.`;

export async function POST(req: Request) {
  try {
    const { id } = await req.json();
    const owner = (process.env.OWNER_EMAIL || '').toLowerCase().trim();

    if (!process.env.GROQ_API_KEY) {
      return NextResponse.json({ error: 'GROQ_API_KEY is not set on the server.' }, { status: 503 });
    }

    const [msg] = await sql`
      select id, ref, from_addr, from_name, sent_at, subject, body_text,
             has_real_attachment, attachments, topics, flags, category
      from emails where id = ${id}
    `;
    if (!msg) return NextResponse.json({ error: 'That message is not in the record.' }, { status: 404 });

    // The four most recent messages in the same exchange, for tone and context.
    const around = await sql`
      select ref, from_addr, sent_at, subject, left(coalesce(body_text,''), 700) as body
      from emails
      where sent_at < ${msg.sent_at}
        and (from_addr = ${msg.from_addr} or lower(from_addr) = ${owner || 'x'})
      order by sent_at desc
      limit 4
    `;

    const context = around
      .reverse()
      .map(
        (r: any) =>
          `[${r.ref}] ${String(r.sent_at).slice(0, 10)} ${
            owner && r.from_addr?.toLowerCase() === owner ? '(owner wrote)' : '(they wrote)'
          }: ${r.body}`
      )
      .join('\n\n');

    const incoming = `[${msg.ref}] ${String(msg.sent_at).slice(0, 10)}
From: ${msg.from_name || ''} <${msg.from_addr}>${
      owner && msg.from_addr?.toLowerCase() === owner ? '  — NOTE: this was sent by the owner, not received' : ''
    }
Subject: ${msg.subject || '(none)'}
Attached: ${msg.has_real_attachment ? JSON.stringify(msg.attachments) : 'nothing'}
Topics: ${(msg.topics || []).join(', ') || 'unclassified'}

${(msg.body_text || '').slice(0, 6000)}`;

    const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
    const messages = [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `EARLIER IN THIS EXCHANGE\n${context || '(nothing earlier on file)'}\n\nMESSAGE TO REPLY TO\n${incoming}`,
      },
    ];

    let detail = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      const payload: any = { model, temperature: 0.3, max_tokens: 1400, messages };
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
        detail = `Groq returned ${res.status}. ${text.slice(0, 220)}`;
        if (res.status === 404 || res.status === 401) break;
        continue;
      }

      const content = JSON.parse(text).choices?.[0]?.message?.content || '';
      const start = content.indexOf('{');
      const end = content.lastIndexOf('}');
      if (start !== -1 && end > start) {
        try {
          return NextResponse.json(JSON.parse(content.slice(start, end + 1)));
        } catch {
          /* fall through to retry */
        }
      }
      detail = 'The model replied, but not with anything readable.';
    }

    return NextResponse.json({ error: detail }, { status: 502 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
