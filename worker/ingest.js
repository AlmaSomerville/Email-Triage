/**
 * Pulls mail from Gmail over IMAP into Postgres.
 *
 *   node ingest.js                              # new mail in INBOX
 *   node ingest.js --folder="[Gmail]/All Mail"  # full history, sent included
 *   node ingest.js --since=2024-01-01           # first run: how far back to go
 *   node ingest.js --loop=300                   # re-check every 300s, forever
 *
 * Resumable: it records the last IMAP UID per folder and carries on from there.
 * Safe to stop and restart at any point.
 */
import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { sql } from './lib/db.js';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const FOLDER = arg('folder', 'INBOX');
const SINCE = arg('since', '2020-01-01');
const BATCH = Number(arg('batch', 40));
const MAX = Number(arg('max', 0));          // 0 = no cap
const LOOP = Number(arg('loop', 0));        // seconds; 0 = run once

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Real attachments only. Inline signature logos and embedded images do not count. */
function realAttachments(parsed) {
  return (parsed.attachments || [])
    .filter((a) => !a.related && a.contentDisposition !== 'inline' && a.filename)
    .map((a) => ({
      filename: a.filename,
      mime: a.contentType || 'application/octet-stream',
      bytes: a.size || (a.content ? a.content.length : 0),
    }));
}

/** Pull text out of PDF attachments so their contents are searchable too. */
async function pdfText(parsed) {
  const pdfs = (parsed.attachments || []).filter(
    (a) => a.content && /pdf/i.test(a.contentType || '') && !a.related
  );
  if (!pdfs.length) return null;
  const out = [];
  for (const p of pdfs) {
    try {
      const { default: pdfParse } = await import('pdf-parse');
      const data = await pdfParse(p.content);
      if (data.text?.trim()) out.push(`[${p.filename}] ${data.text.trim()}`);
    } catch (e) {
      console.warn(`  pdf unreadable: ${p.filename} (${e.message})`);
    }
  }
  return out.length ? out.join('\n\n') : null;
}

async function upsert(input) {
  // ON CONFLICT cannot touch the same row twice in one statement, and
  // [Gmail]/All Mail happily hands you the same Message-ID under two labels.
  const seen = new Map();
  for (const r of input) seen.set(r.message_id, r);
  const rows = [...seen.values()];

  if (!rows.length) return 0;
  const res = await sql`
    insert into emails ${sql(
      rows,
      'message_id', 'imap_uid', 'folder', 'from_addr', 'from_name', 'to_addrs',
      'sent_at', 'subject', 'body_text', 'has_real_attachment', 'attachments',
      'attachment_text'
    )}
    on conflict (message_id) do update set
      folder = excluded.folder,
      imap_uid = excluded.imap_uid
    returning (xmax = 0) as inserted
  `;
  return res.filter((r) => r.inserted).length;
}

async function runOnce() {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.gmail.com',
    port: Number(process.env.IMAP_PORT || 993),
    secure: true,
    auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_APP_PASSWORD },
    logger: false,
  });

  await client.connect();
  const box = await client.mailboxOpen(FOLDER);
  console.log(`${FOLDER}: ${box.exists} messages, uidValidity ${box.uidValidity}`);

  const [state] = await sql`select * from sync_state where folder = ${FOLDER}`;
  let lastUid = state?.last_uid ?? 0;

  if (state && String(state.uid_validity) !== String(box.uidValidity)) {
    console.log('uidValidity changed — Gmail rebuilt this folder. Restarting from 0.');
    lastUid = 0;
  }

  const criteria = lastUid > 0 ? { uid: `${lastUid + 1}:*` } : { since: new Date(SINCE) };
  const uids = await client.search(criteria, { uid: true });
  const todo = (uids || []).filter((u) => u > lastUid).sort((a, b) => a - b);

  if (!todo.length) {
    console.log('Nothing new.');
    await client.logout();
    return 0;
  }
  console.log(`${todo.length} message(s) to fetch.`);

  let added = 0;
  let processed = 0;
  let buffer = [];
  let highest = lastUid;

  for (const uid of todo) {
    if (MAX && processed >= MAX) break;
    try {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg?.source) continue;

      const parsed = await simpleParser(msg.source);
      const messageId = (parsed.messageId || `imap-${FOLDER}-${uid}`).replace(/^<|>$/g, '');
      const atts = realAttachments(parsed);

      buffer.push({
        message_id: messageId,
        imap_uid: uid,
        folder: FOLDER,
        from_addr: parsed.from?.value?.[0]?.address?.toLowerCase() || 'unknown',
        from_name: parsed.from?.value?.[0]?.name || null,
        to_addrs: (parsed.to?.value || []).map((v) => v.address?.toLowerCase()).filter(Boolean),
        sent_at: parsed.date || new Date(),
        subject: parsed.subject || null,
        body_text: parsed.text || parsed.html?.replace(/<[^>]+>/g, ' ') || '',
        has_real_attachment: atts.length > 0,
        attachments: sql.json(atts),   // sql.json, not JSON.stringify: postgres.js
                                       // encodes for jsonb itself and would double-wrap a string
        attachment_text: await pdfText(parsed),
      });

      highest = Math.max(highest, uid);
      processed++;
    } catch (e) {
      console.warn(`  uid ${uid} skipped: ${e.message}`);
      highest = Math.max(highest, uid);
    }

    if (buffer.length >= BATCH) {
      added += await upsert(buffer);
      buffer = [];
      await sql`
        insert into sync_state (folder, last_uid, uid_validity, updated_at)
        values (${FOLDER}, ${highest}, ${String(box.uidValidity)}, now())
        on conflict (folder) do update set
          last_uid = excluded.last_uid,
          uid_validity = excluded.uid_validity,
          updated_at = now()
      `;
      console.log(`  ${processed}/${todo.length} fetched, ${added} new`);
    }
  }

  added += await upsert(buffer);
  await sql`
    insert into sync_state (folder, last_uid, uid_validity, updated_at)
    values (${FOLDER}, ${highest}, ${String(box.uidValidity)}, now())
    on conflict (folder) do update set
      last_uid = excluded.last_uid,
      uid_validity = excluded.uid_validity,
      updated_at = now()
  `;

  await client.logout();
  console.log(`Done. ${added} new message(s) stored.`);
  return added;
}

if (LOOP > 0) {
  for (;;) {
    try {
      await runOnce();
    } catch (e) {
      console.error('Run failed:', e.message);
    }
    console.log(`Sleeping ${LOOP}s.\n`);
    await sleep(LOOP * 1000);
  }
} else {
  await runOnce();
  await sql.end();
}
