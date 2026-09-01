import { registerAs } from '@nestjs/config';

/**
 * pg-boss runs on the same PostgreSQL instance as the app (schema `pgboss`),
 * so the connection string is derived from the existing DB_* env vars rather
 * than introducing a separate QUEUE_* set (per phase-03-videos/TD-01).
 */
export default registerAs('queue', () => {
  const host = process.env.DB_HOST || 'localhost';
  const port = process.env.DB_PORT || '5432';
  const user = encodeURIComponent(process.env.DB_USERNAME || 'streamtube');
  const password = encodeURIComponent(process.env.DB_PASSWORD || 'streamtube');
  const database = process.env.DB_NAME || 'streamtube';

  return {
    connectionString: `postgres://${user}:${password}@${host}:${port}/${database}`,
    schema: 'pgboss',
  };
});
