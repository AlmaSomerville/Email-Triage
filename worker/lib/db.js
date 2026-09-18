import 'dotenv/config';
import postgres from 'postgres';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is missing. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

export const sql = postgres(process.env.DATABASE_URL, {
  prepare: false,          // required for the Supabase transaction pooler
  max: 4,
  idle_timeout: 20,
});
