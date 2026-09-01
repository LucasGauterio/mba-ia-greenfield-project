import { randomUUID } from 'node:crypto';
import { ListMultipartUploadsCommand, S3Client } from '@aws-sdk/client-s3';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { cleanAllTables } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { originalKey } from '../videos/videos.constants';
import { Video } from '../videos/entities/video.entity';
import { StorageService } from '../videos/storage.service';
import { AbandonedUploadCleanupWorker } from './abandoned-upload-cleanup.worker';
import { WorkerModule } from './worker.module';

describe('AbandonedUploadCleanupWorker (integration — real Postgres + MinIO)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let worker: AbandonedUploadCleanupWorker;
  let storageService: StorageService;

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

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await moduleRef.init();

    dataSource = moduleRef.get(DataSource);
    worker = moduleRef.get(AbandonedUploadCleanupWorker);
    storageService = moduleRef.get(StorageService);
  }, 30000);

  afterAll(async () => {
    await cleanAllTables(dataSource);
    rawClient.destroy();
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function seedChannel(): Promise<string> {
    const userId = randomUUID();
    await dataSource.getRepository(User).save({
      id: userId,
      email: `${userId}@example.com`,
      password: 'hash',
      is_confirmed: true,
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: 'chan',
      nickname: `chan-${userId.slice(0, 8)}`,
      user_id: userId,
    });
    return channel.id;
  }

  async function seedVideo(
    channelId: string,
    fields: Partial<Video>,
    ageHours: number,
  ): Promise<Video> {
    const repo = dataSource.getRepository(Video);
    const id = randomUUID();
    await repo.save(
      repo.create({
        id,
        channel_id: channelId,
        slug: id.slice(0, 10),
        storage_key: originalKey(id, 'mp4'),
        ...fields,
      }),
    );
    await dataSource.query(
      `UPDATE videos SET created_at = now() - ($1 || ' hours')::interval WHERE id = $2`,
      [String(ageHours), id],
    );
    return repo.findOneByOrFail({ id });
  }

  async function openMultipartCount(key: string): Promise<number> {
    const res = await rawClient.send(
      new ListMultipartUploadsCommand({ Bucket: config.bucket, Prefix: key }),
    );
    return res.Uploads?.length ?? 0;
  }

  it('reclaims an aged draft, aborts its multipart, and leaves fresh/ready rows alone', async () => {
    const channelId = await seedChannel();

    const oldKey = originalKey(randomUUID(), 'mp4');
    const oldUploadId = await storageService.createMultipartUpload(
      oldKey,
      'video/mp4',
    );
    const oldDraft = await seedVideo(
      channelId,
      { status: 'draft', storage_key: oldKey, upload_id: oldUploadId },
      48,
    );
    expect(await openMultipartCount(oldKey)).toBe(1);

    const freshDraft = await seedVideo(
      channelId,
      { status: 'draft', upload_id: 'fresh-upload' },
      2,
    );
    const readyVideo = await seedVideo(channelId, { status: 'ready' }, 72);

    await worker.handleJob();

    const repo = dataSource.getRepository(Video);
    const reclaimed = await repo.findOneByOrFail({ id: oldDraft.id });
    expect(reclaimed.status).toBe('error');
    expect(reclaimed.error_reason).toBe('upload_abandoned_ttl_exceeded');
    expect(reclaimed.upload_id).toBeNull();
    expect(await openMultipartCount(oldKey)).toBe(0);

    expect((await repo.findOneByOrFail({ id: freshDraft.id })).status).toBe(
      'draft',
    );
    expect((await repo.findOneByOrFail({ id: readyVideo.id })).status).toBe(
      'ready',
    );

    // Idempotent — a second sweep over the same data changes nothing.
    await worker.handleJob();
    expect((await repo.findOneByOrFail({ id: oldDraft.id })).status).toBe(
      'error',
    );
  }, 30000);
});
