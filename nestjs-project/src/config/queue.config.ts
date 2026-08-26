import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  connectionString: `postgres://${process.env.DB_USERNAME || 'streamtube'}:${process.env.DB_PASSWORD || 'streamtube'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || '5432'}/${process.env.DB_NAME || 'streamtube'}`,
}));
