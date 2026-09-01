import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { cleanAllTables } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';

describe('VideosService.completeUpload (integration — real Postgres + pg-boss + MinIO)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let videosService: VideosService;

  const config = storageConfig();
  const rawClient = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  const createdKeys: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    // init() runs onModuleInit — starts pg-boss and declares the queue.
    await moduleRef.init();

    dataSource = moduleRef.get(DataSource);
    videosService = moduleRef.get(VideosService);
  }, 30000);

  afterAll(async () => {
    await cleanAllTables(dataSource);
    await Promise.all(
      createdKeys.map((Key) =>
        rawClient
          .send(new DeleteObjectCommand({ Bucket: config.bucket, Key }))
          .catch(() => undefined),
      ),
    );
    rawClient.destroy();
    // Closes the whole module → onModuleDestroy stops pg-boss (no "Jest did not
    // exit"), then the TypeORM pool closes.
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function seedChannel(): Promise<{ userId: string }> {
    const userId = randomUUID();
    await dataSource.getRepository(User).save({
      id: userId,
      email: `${userId}@example.com`,
      password: 'hash',
      is_confirmed: true,
    });
    await dataSource.getRepository(Channel).save({
      name: 'chan',
      nickname: `chan-${userId.slice(0, 8)}`,
      user_id: userId,
    });
    return { userId };
  }

  it('enqueues exactly one video-processing job carrying its own videoId', async () => {
    const { userId } = await seedChannel();

    const initiated = await videosService.initiateUpload(userId, {
      fileName: 'clip.mp4',
      fileSize: 4096,
      contentType: 'video/mp4',
    });
    createdKeys.push(`videos/${initiated.id}/original.mp4`);

    const put = await fetch(initiated.parts[0].url, {
      method: 'PUT',
      body: Buffer.from('x'.repeat(4096)),
    });
    expect(put.ok).toBe(true);
    const eTag = put.headers.get('etag');
    expect(eTag).toBeTruthy();

    const result = await videosService.completeUpload(initiated.id, userId, [
      { partNumber: 1, eTag: eTag ?? '' },
    ]);

    expect(result).toEqual({ id: initiated.id, status: 'processing' });

    const row = await dataSource.getRepository(Video).findOneByOrFail({
      id: initiated.id,
    });
    expect(row.status).toBe('processing');
    expect(row.upload_id).toBeNull();

    const jobs = await dataSource.query<{ id: string }[]>(
      `SELECT id FROM pgboss.job WHERE name = 'video-processing' AND data->>'videoId' = $1`,
      [initiated.id],
    );
    expect(jobs).toHaveLength(1);
  }, 30000);
});
