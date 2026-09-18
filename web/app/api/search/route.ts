import { NextResponse } from 'next/server';
import { sql, gmailLink } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Turns whatever was typed into a bilingual term list.
 * If the words match a saved vocabulary (damp, health, school...) the whole
 * list is used, so a search for "damp" also finds "moho" and "humedad".
 */
async function expand(query: string): Promise<string[] | null> {
  const raw = (query || '').trim();
  if (!raw) return null;

  const words = raw.toLowerCase().split(/[\s,]+/).filter(Boolean);
  const vocab = await sql<{ key: string; terms: string[] }[]>`
    select key, terms from claim_terms
  `;

  const out = new Set<string>(words);
  for (const v of vocab) {
    const hit = v.terms.some((t) => words.includes(t.toLowerCase())) || words.includes(v.key);
    if (hit) v.terms.forEach((t) => out.add(t));
  }
  return [...out];
}

/**
 * jsonb columns can arrive as an array, or as a string holding one, depending
 * on how the row was written. The interface should never crash over that.
 */
function asArray(v: any): any[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export async function POST(req: Request) {
  try {
    const b = await req.json();
    const terms = b.expand === false
      ? (b.query?.trim() ? b.query.trim().split(/[\s,]+/) : null)
      : await expand(b.query);

    const rows = await sql`
      select * from search_emails(
        ${terms as any},
        ${b.from || null},
        ${b.dateFrom || null},
        ${b.dateTo || null},
        ${(b.tagIds?.length ? b.tagIds : null) as any},
        ${(b.categories?.length ? b.categories : null) as any},
        ${b.hasAttachment ?? null},
        ${Number(b.limit || 100)},
        ${Number(b.offset || 0)}
      )
    `;

    const stats = rows.length
      ? {
          total: Number(rows[0].total_count),
          firstSent: rows[0].first_sent,
          lastSent: rows[0].last_sent,
          withAttachment: Number(rows[0].with_attachment),
        }
      : { total: 0, firstSent: null, lastSent: null, withAttachment: 0 };

    return NextResponse.json({
      stats,
      termsUsed: terms,
      rows: rows.map((r: any) => ({
        id: r.id,
        ref: r.ref,
        sentAt: r.sent_at,
        from: r.from_name || r.from_addr,
        fromAddr: r.from_addr,
        subject: r.subject,
        snippet: r.snippet,
        body: (r.body_text || '').slice(0, 12000),
        category: r.category,
        events: asArray(r.events),
        tags: asArray(r.tags),
        attachments: asArray(r.attachments),
        hasAttachment: r.has_real_attachment,
        link: gmailLink(r.gm_msgid, r.message_id),
      })),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
