import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.POSTER_DB_PATH ?? './data/app.db' },
  strict: true,
  verbose: true,
});
