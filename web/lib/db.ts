import postgres from 'postgres';

const globalForDb = globalThis as unknown as { sql?: ReturnType<typeof postgres> };

export const sql =
  globalForDb.sql ??
  postgres(process.env.DATABASE_URL!, { prepare: false, max: 3, idle_timeout: 20 });

if (process.env.NODE_ENV !== 'production') globalForDb.sql = sql;

/**
 * Gmail's own message id opens the message directly. The rfc822msgid search
 * is only a fallback: it fails on ids containing '+' and on some ids issued
 * by other mail systems, which is most of a co-parenting inbox.
 */
export function gmailLink(gmMsgid: string | null, messageId: string) {
  if (gmMsgid) {
    const hex = /^\d+$/.test(gmMsgid) ? BigInt(gmMsgid).toString(16) : gmMsgid;
    return `https://mail.google.com/mail/u/0/#all/${hex}`;
  }
  return `https://mail.google.com/mail/u/0/#search/rfc822msgid%3A${encodeURIComponent(messageId)}`;
}
