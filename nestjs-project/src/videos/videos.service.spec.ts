import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import { VideoFileTooLargeException } from '../common/exceptions/domain.exception';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { StorageService } from './storage.service';
import { VideosService } from './videos.service';
import { MAX_FILE_SIZE_BYTES } from './videos.constants';

function makeChannel(): Channel {
  const c = new Channel();
  c.id = 'channel-id';
  c.name = 'chan';
  c.nickname = 'chan';
  c.user_id = 'user-id';
  c.description = null;
  c.created_at = new Date();
  c.updated_at = new Date();
  return c;
}

function makeVideo(overrides: Partial<Video> = {}): Video {
  const v = new Video();
  v.id = 'video-id';
  v.channel_id = 'channel-id';
  v.slug = 'abc1234567';
  v.title = null;
  v.status = VideoStatus.DRAFT;
  v.error_reason = null;
  v.storage_key = 'videos/video-id/original.mp4';
  v.thumbnail_key = null;
  v.upload_id = 'upload-123';
  v.duration_seconds = null;
  v.metadata = null;
  v.created_at = new Date();
  v.updated_at = new Date();
  return Object.assign(v, overrides);
}

function makeUniqueSlugError(): QueryFailedError {
  const err = new QueryFailedError('INSERT', [], new Error()) as any;
  err.code = '23505';
  err.detail = 'Key (slug)=(abc1234567) already exists.';
  return err;
}

function makeVideoRepository(): any {
  return {
    create: jest.fn((entityLike) => entityLike),
    save: jest.fn(),
    findOneBy: jest.fn(),
  };
}

function makeChannelsService(): any {
  return { findByUserId: jest.fn() };
}

function makeStorageService(): any {
  return {
    createMultipartUpload: jest.fn(),
    getUploadPartUrl: jest.fn(),
  };
}

function makeDto(overrides: Partial<CreateVideoDto> = {}): CreateVideoDto {
  return {
    fileName: 'movie.mp4',
    fileSize: 30 * 1024 ** 2, // 30MB
    contentType: 'video/mp4',
    ...overrides,
  };
}

describe('VideosService', () => {
  describe('initiateUpload', () => {
    it('throws VideoFileTooLargeException when fileSize exceeds the 10GB cap', async () => {
      const channelsService = makeChannelsService();
      const storageService = makeStorageService();
      const service = new VideosService(
        makeVideoRepository(),
        channelsService as ChannelsService,
        storageService as StorageService,
      );

      await expect(
        service.initiateUpload(
          'user-id',
          makeDto({ fileSize: MAX_FILE_SIZE_BYTES + 1 }),
        ),
      ).rejects.toThrow(VideoFileTooLargeException);
      expect(channelsService.findByUserId).not.toHaveBeenCalled();
    });

    it('throws when the authenticated user has no channel', async () => {
      const channelsService = makeChannelsService();
      channelsService.findByUserId!.mockResolvedValue(null);
      const storageService = makeStorageService();
      const service = new VideosService(
        makeVideoRepository(),
        channelsService as ChannelsService,
        storageService as StorageService,
      );

      await expect(
        service.initiateUpload('user-id', makeDto()),
      ).rejects.toThrow('Channel not found for authenticated user');
    });

    it('creates a multipart upload and returns presigned parts for a valid request', async () => {
      const channel = makeChannel();
      const channelsService = makeChannelsService();
      channelsService.findByUserId!.mockResolvedValue(channel);

      const storageService = makeStorageService();
      storageService.createMultipartUpload!.mockResolvedValue('upload-123');
      storageService.getUploadPartUrl!.mockImplementation(
        (_key: string, _uploadId: string, partNumber: number) =>
          `https://storage.local/part-${partNumber}`,
      );

      const videoRepository = makeVideoRepository();
      videoRepository.save.mockImplementation((entityLike: any) =>
        makeVideo({ ...entityLike }),
      );

      const service = new VideosService(
        videoRepository,
        channelsService as ChannelsService,
        storageService as StorageService,
      );

      const result = await service.initiateUpload(
        'user-id',
        makeDto({ fileSize: 30 * 1024 ** 2 }), // 30MB -> 2 parts of 25MB
      );

      expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\/.+\/original\.mp4$/),
        'video/mp4',
      );
      expect(result.uploadId).toBe('upload-123');
      expect(result.parts).toEqual([
        { partNumber: 1, uploadUrl: 'https://storage.local/part-1' },
        { partNumber: 2, uploadUrl: 'https://storage.local/part-2' },
      ]);
      expect(videoRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: channel.id,
          storage_key: expect.stringMatching(/^videos\/.+\/original\.mp4$/),
          upload_id: 'upload-123',
        }),
      );
    });

    it('generates a fresh slug and retries when the DB reports a unique constraint violation', async () => {
      const channel = makeChannel();
      const channelsService = makeChannelsService();
      channelsService.findByUserId!.mockResolvedValue(channel);

      const storageService = makeStorageService();
      storageService.createMultipartUpload!.mockResolvedValue('upload-123');
      storageService.getUploadPartUrl!.mockResolvedValue(
        'https://storage.local/part-1',
      );

      const videoRepository = makeVideoRepository();
      videoRepository.save
        .mockRejectedValueOnce(makeUniqueSlugError())
        .mockImplementationOnce((entityLike: any) =>
          makeVideo({ ...entityLike }),
        );

      const service = new VideosService(
        videoRepository,
        channelsService as ChannelsService,
        storageService as StorageService,
      );

      const result = await service.initiateUpload('user-id', makeDto());

      expect(videoRepository.save).toHaveBeenCalledTimes(2);
      const [firstAttempt, secondAttempt] =
        videoRepository.create.mock.calls.map((call: any[]) => call[0].slug);
      expect(firstAttempt).not.toBe(secondAttempt);
      expect(result.slug).toBeDefined();
    });

    it('throws after exhausting max slug retries', async () => {
      const channel = makeChannel();
      const channelsService = makeChannelsService();
      channelsService.findByUserId!.mockResolvedValue(channel);

      const storageService = makeStorageService();
      storageService.createMultipartUpload!.mockResolvedValue('upload-123');
      storageService.getUploadPartUrl!.mockResolvedValue(
        'https://storage.local/part-1',
      );

      const videoRepository = makeVideoRepository();
      videoRepository.save.mockRejectedValue(makeUniqueSlugError());

      const service = new VideosService(
        videoRepository,
        channelsService as ChannelsService,
        storageService as StorageService,
      );

      await expect(
        service.initiateUpload('user-id', makeDto()),
      ).rejects.toThrow(
        'Slug conflict could not be resolved after max retries',
      );
    });
  });
});
