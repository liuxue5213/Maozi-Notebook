import type { Config } from 'drizzle-kit';

const url = process.env.DATABASE_URL ?? 'mysql://ledgerone:ledgerone@127.0.0.1:3306/ledgerone';

export default {
  dialect: 'mysql',
  dbCredentials: { url },
  schema: './src/db/schema.ts',
  out: './drizzle-mysql',
} satisfies Config;
