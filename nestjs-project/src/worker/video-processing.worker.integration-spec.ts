import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import execa from 'execa';
import ffmpegPathRaw from 'ffmpeg-static';
import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { cleanAllTables } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { originalKey, thumbnailKey } from '../videos/videos.constants';
import { Video } from '../videos/entities/video.entity';
import { StorageService } from '../videos/storage.service';
import { VideoProcessingWorker } from './video-processing.worker';
import { WorkerModule } from './worker.module';

const ffmpegPath = ffmpegPathRaw as string;

describe('VideoProcessingWorker (integration — real MinIO + Postgres + ffmpeg)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let worker: VideoProcessingWorker;
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
  const createdKeys: string[] = [];
  let fixtureDir: string;
  let fixturePath: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await moduleRef.init();

    dataSource = moduleRef.get(DataSource);
    worker = moduleRef.get(VideoProcessingWorker);
    storageService = moduleRef.get(StorageService);

    fixtureDir = await mkdtemp(join(tmpdir(), 'worker-fixture-'));
    fixturePath = join(fixtureDir, 'sample.mp4');
    await execa(ffmpegPath, [
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=1:size=320x240:rate=10',
      '-pix_fmt',
      'yuv420p',
      '-y',
      fixturePath,
    ]);
  }, 60000);

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
    await rm(fixtureDir, { recursive: true, force: true });
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  it('probes the original, writes a JPEG thumbnail and moves the row to ready', async () => {
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

    const videoId = randomUUID();
    const key = originalKey(videoId, 'mp4');
    createdKeys.push(key, thumbnailKey(videoId));

    const videoRepo = dataSource.getRepository(Video);
    await videoRepo.save(
      videoRepo.create({
        id: videoId,
        channel_id: channel.id,
        slug: videoId.slice(0, 10),
        status: 'processing',
        storage_key: key,
      }),
    );

    await storageService.uploadObject(key, fixturePath, 'video/mp4');

    await worker.handleJob({
      data: { videoId },
      retryCount: 0,
      retryLimit: 3,
    });

    const row = await videoRepo.findOneByOrFail({ id: videoId });
    expect(row.status).toBe('ready');
    expect(row.duration_seconds).toBeGreaterThanOrEqual(1);
    expect(row.metadata).not.toBeNull();
    expect(row.thumbnail_key).toBe(thumbnailKey(videoId));

    const head = await storageService.headObject(thumbnailKey(videoId));
    expect(head.contentLength).toBeGreaterThan(0);

    const localThumb = join(fixtureDir, `thumb-${videoId}.jpg`);
    await storageService.downloadObject(thumbnailKey(videoId), localThumb);
    const bytes = await readFile(localThumb);
    // JPEG magic number.
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(
      true,
    );
  }, 60000);
});
