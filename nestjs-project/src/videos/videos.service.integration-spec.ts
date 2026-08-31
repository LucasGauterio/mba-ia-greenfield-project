import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import {
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoUploadAlreadyCompletedException,
} from '../common/exceptions/domain.exception';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { QueueModule } from '../queue/queue.module';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { StorageService } from './storage.service';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

function etagFrom(response: Response): string {
  const etag = response.headers.get('etag');
  if (etag === null) {
    throw new Error('storage did not return an ETag for the uploaded part');
  }
  return etag.replace(/"/g, '');
}

describe('VideosService (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelsService: ChannelsService;
  let storageService: StorageService;
  let videosService: VideosService;

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
      providers: [VideosService, StorageService, ChannelsService],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelsService = moduleRef.get(ChannelsService);
    storageService = moduleRef.get(StorageService);
    videosService = moduleRef.get(VideosService);
  }, 30000);

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_svc_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelsService.createChannel(user.id, user.email);
  }

  it('persists a draft video with the correct fields', async () => {
    const channel = await createChannel();

    const result = await videosService.initiateUpload(channel.user_id, {
      fileName: 'clip.mp4',
      fileSize: 12 * 1024 ** 2,
      contentType: 'video/mp4',
      title: 'My clip',
    });

    expect(result.id).toBeDefined();
    expect(result.slug).toHaveLength(10);
    expect(result.status).toBe(VideoStatus.DRAFT);
    expect(result.uploadId).toBeDefined();
    expect(result.parts.length).toBeGreaterThan(0);
    expect(result.parts[0].uploadUrl).toContain('http');

    const persisted = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: result.id });
    expect(persisted).not.toBeNull();
    expect(persisted.channel_id).toBe(channel.id);
    expect(persisted.title).toBe('My clip');
    expect(persisted.status).toBe(VideoStatus.DRAFT);
    expect(persisted.storage_key).toBe(`videos/${result.id}/original.mp4`);
    expect(persisted.upload_id).toBe(result.uploadId);
  }, 30000);

  it('produces no colliding slugs under concurrent initiations', async () => {
    const channel = await createChannel();

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        videosService.initiateUpload(channel.user_id, {
          fileName: `clip-${i}.mp4`,
          fileSize: 1024,
          contentType: 'video/mp4',
        }),
      ),
    );

    const slugs = results.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  }, 30000);

  describe('completeUpload', () => {
    async function initiateSmallUpload(channel: Channel) {
      return videosService.initiateUpload(channel.user_id, {
        fileName: 'clip.txt',
        fileSize: 10,
        contentType: 'text/plain',
      });
    }

    it('completes a real multipart upload and flips status to processing', async () => {
      const channel = await createChannel();
      const draft = await initiateSmallUpload(channel);
      const storageKey = `videos/${draft.id}/original.txt`;
      const body = Buffer.from('0123456789');

      const uploadResponse = await fetch(draft.parts[0].uploadUrl, {
        method: 'PUT',
        body,
      });
      const eTag = etagFrom(uploadResponse);

      const result = await videosService.completeUpload(
        channel.user_id,
        draft.id,
        { parts: [{ partNumber: 1, eTag }] },
      );

      expect(result).toEqual({ id: draft.id, status: VideoStatus.PROCESSING });

      const persisted = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: draft.id });
      expect(persisted.status).toBe(VideoStatus.PROCESSING);

      const exists = await storageService.verifyObjectExists(storageKey);
      expect(exists).toBe(true);
    }, 30000);

    it('throws VideoNotFoundException for an unknown video id', async () => {
      const channel = await createChannel();

      await expect(
        videosService.completeUpload(
          channel.user_id,
          '00000000-0000-0000-0000-000000000000',
          { parts: [{ partNumber: 1, eTag: 'etag' }] },
        ),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('throws VideoNotOwnedException when a different user attempts completion', async () => {
      const channel = await createChannel();
      const draft = await initiateSmallUpload(channel);

      const otherChannel = await createChannel();

      await expect(
        videosService.completeUpload(otherChannel.user_id, draft.id, {
          parts: [{ partNumber: 1, eTag: 'etag' }],
        }),
      ).rejects.toThrow(VideoNotOwnedException);
    });

    it('throws VideoUploadAlreadyCompletedException when called twice', async () => {
      const channel = await createChannel();
      const draft = await initiateSmallUpload(channel);
      const body = Buffer.from('0123456789');

      const uploadResponse = await fetch(draft.parts[0].uploadUrl, {
        method: 'PUT',
        body,
      });
      const eTag = etagFrom(uploadResponse);

      await videosService.completeUpload(channel.user_id, draft.id, {
        parts: [{ partNumber: 1, eTag }],
      });

      await expect(
        videosService.completeUpload(channel.user_id, draft.id, {
          parts: [{ partNumber: 1, eTag }],
        }),
      ).rejects.toThrow(VideoUploadAlreadyCompletedException);
    }, 30000);
  });

  describe('getStreamUrl / getDownloadUrl', () => {
    async function createReadyVideo(channel: Channel): Promise<Video> {
      const draft = await videosService.initiateUpload(channel.user_id, {
        fileName: 'clip.txt',
        fileSize: 10,
        contentType: 'text/plain',
      });
      const body = Buffer.from('0123456789');
      const uploadResponse = await fetch(draft.parts[0].uploadUrl, {
        method: 'PUT',
        body,
      });
      const eTag = uploadResponse.headers.get('etag')!.replace(/"/g, '');

      await videosService.completeUpload(channel.user_id, draft.id, {
        parts: [{ partNumber: 1, eTag }],
      });

      const videoRepository = dataSource.getRepository(Video);
      await videoRepository.update(
        { id: draft.id },
        { status: VideoStatus.READY },
      );
      return videoRepository.findOneByOrFail({ id: draft.id });
    }

    it('getStreamUrl returns a working presigned GET URL', async () => {
      const channel = await createChannel();
      const video = await createReadyVideo(channel);

      const url = await videosService.getStreamUrl(video.slug);
      const res = await fetch(url);

      expect(res.status).toBe(200);
      expect(await res.text()).toBe('0123456789');
    }, 30000);

    it('getDownloadUrl returns a presigned GET URL with an attachment disposition', async () => {
      const channel = await createChannel();
      const video = await createReadyVideo(channel);

      const url = await videosService.getDownloadUrl(video.slug);
      const res = await fetch(url);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toContain('attachment');
    }, 30000);

    it('throws VideoNotFoundException for a non-ready video requested anonymously', async () => {
      const channel = await createChannel();
      const draft = await videosService.initiateUpload(channel.user_id, {
        fileName: 'clip.txt',
        fileSize: 10,
        contentType: 'text/plain',
      });

      await expect(videosService.getStreamUrl(draft.slug)).rejects.toThrow(
        VideoNotFoundException,
      );
    }, 30000);
  });
});
