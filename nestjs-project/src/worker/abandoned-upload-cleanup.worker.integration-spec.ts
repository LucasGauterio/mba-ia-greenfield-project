import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { QueueModule } from '../queue/queue.module';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { StorageService } from '../videos/storage.service';
import { VideosService } from '../videos/videos.service';
import { ABANDONED_UPLOAD_TTL_HOURS } from '../videos/videos.constants';
import { AbandonedUploadCleanupWorker } from './abandoned-upload-cleanup.worker';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const MS_PER_HOUR = 60 * 60 * 1000;

describe('AbandonedUploadCleanupWorker (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let userRepository: Repository<User>;
  let channelsService: ChannelsService;
  let storageService: StorageService;
  let videosService: VideosService;
  let worker: AbandonedUploadCleanupWorker;

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
      providers: [
        VideosService,
        StorageService,
        ChannelsService,
        AbandonedUploadCleanupWorker,
      ],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    userRepository = dataSource.getRepository(User);
    channelsService = moduleRef.get(ChannelsService);
    storageService = moduleRef.get(StorageService);
    videosService = moduleRef.get(VideosService);
    worker = moduleRef.get(AbandonedUploadCleanupWorker);
  }, 30000);

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createDraft(ageHours: number): Promise<Video> {
    const user = await userRepository.save(
      userRepository.create({
        email: `cleanup_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelsService.createChannel(user.id, user.email);

    const draft = await videosService.initiateUpload(channel.user_id, {
      fileName: 'clip.txt',
      fileSize: 10,
      contentType: 'text/plain',
    });

    await videoRepository.update(
      { id: draft.id },
      { created_at: new Date(Date.now() - ageHours * MS_PER_HOUR) },
    );

    return videoRepository.findOneByOrFail({ id: draft.id });
  }

  it('flips a draft older than the TTL to error and aborts its multipart upload', async () => {
    const stale = await createDraft(ABANDONED_UPLOAD_TTL_HOURS + 1);

    await worker.process();

    const persisted = await videoRepository.findOneByOrFail({ id: stale.id });
    expect(persisted.status).toBe(VideoStatus.ERROR);
    expect(persisted.error_reason).toBe('upload_abandoned_ttl_exceeded');

    const { upload_id } = stale;
    if (upload_id === null) {
      throw new Error('draft fixture is missing its upload_id');
    }
    await expect(
      storageService.completeMultipartUpload(stale.storage_key, upload_id, []),
    ).rejects.toThrow();
  }, 30000);

  it('does not touch a draft newer than the TTL', async () => {
    const fresh = await createDraft(1);

    await worker.process();

    const persisted = await videoRepository.findOneByOrFail({ id: fresh.id });
    expect(persisted.status).toBe(VideoStatus.DRAFT);
    expect(persisted.error_reason).toBeNull();
  }, 30000);

  it('leaves already-processed videos alone', async () => {
    const ready = await createDraft(ABANDONED_UPLOAD_TTL_HOURS + 1);
    await videoRepository.update(
      { id: ready.id },
      { status: VideoStatus.READY },
    );

    await worker.process();

    const persisted = await videoRepository.findOneByOrFail({ id: ready.id });
    expect(persisted.status).toBe(VideoStatus.READY);
  }, 30000);
});
