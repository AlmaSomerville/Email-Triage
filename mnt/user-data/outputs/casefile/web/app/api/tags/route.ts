import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const tags = await sql`
    select t.id, t.name, t.color, t.note, count(et.email_id)::int as uses
    from tags t left join email_tags et on et.tag_id = t.id
    group by t.id order by t.name
  `;
  return NextResponse.json({ tags });
}

/** Create a tag, or attach/detach one from a message. */
export async function POST(req: Request) {
  const b = await req.json();
  try {
    if (b.action === 'create') {
      const [tag] = await sql`
        insert into tags (name, color) values (${b.name}, ${b.color || '#1F4E79'})
        on conflict (name) do update set color = excluded.color
        returning id, name, color
      `;
      return NextResponse.json({ tag });
    }
    if (b.action === 'attach') {
      await sql`
        insert into email_tags (email_id, tag_id) values (${b.emailId}, ${b.tagId})
        on conflict do nothing
      `;
      return NextResponse.json({ ok: true });
    }
    if (b.action === 'detach') {
      await sql`delete from email_tags where email_id = ${b.emailId} and tag_id = ${b.tagId}`;
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
