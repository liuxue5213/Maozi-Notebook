import type { Config } from 'drizzle-kit';

const url = process.env.DATABASE_URL ?? 'pglite://data/ledgerone';
const isPglite = url.startsWith('pglite://');

export default {
  dialect: 'postgresql',
  ...(isPglite
    ? { driver: 'pglite', dbCredentials: { url: url.slice('pglite://'.length) } }
    : { dbCredentials: { url } }),
  schema: './src/db/schema.ts',
  out: './drizzle',
} satisfies Config;
