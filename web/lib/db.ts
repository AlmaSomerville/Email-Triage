import postgres from 'postgres';

const globalForDb = globalThis as unknown as { sql?: ReturnType<typeof postgres> };

export const sql =
  globalForDb.sql ??
  postgres(process.env.DATABASE_URL!, { prepare: false, max: 3, idle_timeout: 20 });

if (process.env.NODE_ENV !== 'production') globalForDb.sql = sql;

/** Deep link that opens the exact message in Gmail, by its Message-ID header. */
export function gmailLink(messageId: string) {
  return `https://mail.google.com/mail/u/0/#search/rfc822msgid%3A${encodeURIComponent(messageId)}`;
}
