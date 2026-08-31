import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import execa from 'execa';
import ffmpegPath from 'ffmpeg-static';
import type { JobWithMetadata, PgBoss } from 'pg-boss';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { PG_BOSS, QUEUE_NAMES } from '../queue/queue.constants';
import { QueueModule } from '../queue/queue.module';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { StorageService } from '../videos/storage.service';
import {
  VideoProcessingJobData,
  VideoProcessingWorker,
} from './video-processing.worker';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoProcessingWorker (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let worker: VideoProcessingWorker;
  let boss: PgBoss;
  let fixtureDir: string;
  let sampleVideoPath: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        QueueModule,
      ],
      providers: [StorageService, VideoProcessingWorker],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    storageService = moduleRef.get(StorageService);
    worker = moduleRef.get(VideoProcessingWorker);
    boss = moduleRef.get(PG_BOSS);

    fixtureDir = await mkdtemp(join(tmpdir(), 'worker-fixture-'));
    sampleVideoPath = join(fixtureDir, 'sample.mp4');
    if (!ffmpegPath) {
      throw new Error('ffmpeg binary not available for this platform');
    }
    await execa(ffmpegPath, [
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=64x64:d=1',
      '-c:v',
      'libx264',
      '-t',
      '1',
      '-pix_fmt',
      'yuv420p',
      sampleVideoPath,
    ]);
  }, 60000);

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createDraftVideo(): Promise<Video> {
    const user = await userRepository.save(
      userRepository.create({
        email: `worker_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: 'chan',
        nickname: `worker_chan_${counter}`,
        user_id: user.id,
      }),
    );

    const id = randomUUID();
    const storageKey = `videos/${id}/original.mp4`;
    await storageService.uploadObject(storageKey, sampleVideoPath, 'video/mp4');

    return videoRepository.save(
      videoRepository.create({
        id,
        channel_id: channel.id,
        slug: id.slice(0, 10),
        status: VideoStatus.PROCESSING,
        storage_key: storageKey,
        upload_id: 'upload-id',
      }),
    );
  }

  it('processes a valid video: extracts metadata, uploads a thumbnail, and flips status to ready', async () => {
    const video = await createDraftVideo();

    await worker.process(video.id);

    const persisted = await videoRepository.findOneByOrFail({ id: video.id });
    expect(persisted.status).toBe(VideoStatus.READY);
    expect(persisted.duration_seconds).toBeGreaterThanOrEqual(0);
    expect(persisted.metadata).toHaveProperty('format');
    expect(persisted.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);

    const { thumbnail_key } = persisted;
    if (thumbnail_key === null) {
      throw new Error('worker did not persist a thumbnail_key');
    }
    const thumbnailExists =
      await storageService.verifyObjectExists(thumbnail_key);
    expect(thumbnailExists).toBe(true);
  }, 30000);

  it('processes a job dispatched through the real queue end-to-end', async () => {
    const video = await createDraftVideo();

    // The pgboss.job table is shared across the whole test suite and is never
    // cleaned between files. Leftover jobs from earlier suites (e.g. those
    // enqueued by videos.service.integration-spec.ts) would otherwise be drained
    // through handleJob first — each doing a real ffmpeg/MinIO round-trip — and
    // push this test past its timeout. Purge the backlog before subscribing.
    await boss.deleteAllJobs(QUEUE_NAMES.VIDEO_PROCESSING);

    // A leftover job could still race in between the purge and offWork below, so
    // only resolve/reject on the job this test actually sent; let any other job
    // run through handleJob on its own without affecting the assertion.
    const workDone = new Promise<void>((resolve, reject) => {
      void boss.work(
        QUEUE_NAMES.VIDEO_PROCESSING,
        { includeMetadata: true },
        async ([job]: JobWithMetadata<VideoProcessingJobData>[]) => {
          if (job.data.videoId !== video.id) {
            await worker.handleJob(job).catch(() => undefined);
            return;
          }
          try {
            await worker.handleJob(job);
            resolve();
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        },
      );
    });

    await boss.send(QUEUE_NAMES.VIDEO_PROCESSING, { videoId: video.id });
    await workDone;
    await boss.offWork(QUEUE_NAMES.VIDEO_PROCESSING);

    const persisted = await videoRepository.findOneByOrFail({ id: video.id });
    expect(persisted.status).toBe(VideoStatus.READY);
  }, 30000);
});
