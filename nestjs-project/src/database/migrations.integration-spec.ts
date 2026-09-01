import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1788212809103 } from './migrations/1788212809103-CreateVideos';
import { createTestDataSource } from '../test/create-test-data-source';

// Ordered children-before-parents so the sequential cleanup below never
// deadlocks two concurrent `DROP TABLE ... CASCADE` / `DROP TYPE` (PLAN §11.3).
const MANAGED_TABLES = [
  'videos',
  'refresh_tokens',
  'verification_tokens',
  'channels',
  'users',
];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1788212809103,
        ],
      },
    );

    await dataSource.initialize();

    // Sequential — never Promise.all — so concurrent CASCADE drops on pooled
    // connections don't deadlock now that a second enum (videos_status_enum)
    // exists (PLAN §11.3). Drop tables first, then the enum TYPEs they used:
    // `DROP TABLE ... CASCADE` does not remove an enum type (the column depends
    // on the type, not the reverse), so `runMigrations()` would then fail with
    // "type ... already exists" if a prior run left the schema migrated.
    for (const table of MANAGED_TABLES) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }
    await dataSource.query(`DROP TABLE IF EXISTS "migrations" CASCADE`);
    await dataSource.query(`DROP TYPE IF EXISTS "videos_status_enum"`);
    await dataSource.query(
      `DROP TYPE IF EXISTS "verification_tokens_type_enum"`,
    );
  });

  afterAll(async () => {
    // The second test undoes the last migration, leaving `videos` missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should apply all migrations and create every managed table', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
  });

  it('should revert the last migration and drop the videos table', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['videos', 'refresh_tokens']],
    );
    // videos is gone; the token tables from the earlier migration remain.
    expect(result.map((r) => r.table_name)).toEqual(['refresh_tokens']);
  });
});
