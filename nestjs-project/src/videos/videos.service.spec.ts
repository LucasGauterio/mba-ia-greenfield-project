import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import {
  VideoFileTooLargeException,
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoUploadAlreadyCompletedException,
  VideoUploadVerificationFailedException,
} from '../common/exceptions/domain.exception';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { StorageService } from './storage.service';
import { VideosService } from './videos.service';
import { MAX_FILE_SIZE_BYTES } from './videos.constants';

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  const c = new Channel();
  c.id = 'channel-id';
  c.name = 'chan';
  c.nickname = 'chan';
  c.user_id = 'user-id';
  c.description = null;
  c.created_at = new Date();
  c.updated_at = new Date();
  return Object.assign(c, overrides);
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
    completeMultipartUpload: jest.fn(),
    verifyObjectExists: jest.fn(),
    getObjectUrl: jest.fn(),
  };
}

function makeBoss(): any {
  return { send: jest.fn() };
}

function makeDto(overrides: Partial<CreateVideoDto> = {}): CreateVideoDto {
  return {
    fileName: 'movie.mp4',
    fileSize: 30 * 1024 ** 2, // 30MB
    contentType: 'video/mp4',
    ...overrides,
  };
}

function makeCompleteUploadDto(
  overrides: Partial<CompleteUploadDto> = {},
): CompleteUploadDto {
  return {
    parts: [{ partNumber: 1, eTag: 'etag-1' }],
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
        makeBoss(),
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
        makeBoss(),
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
        makeBoss(),
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
        makeBoss(),
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
        makeBoss(),
      );

      await expect(
        service.initiateUpload('user-id', makeDto()),
      ).rejects.toThrow(
        'Slug conflict could not be resolved after max retries',
      );
    });
  });

  describe('completeUpload', () => {
    it('throws VideoNotFoundException when the video does not exist', async () => {
      const videoRepository = makeVideoRepository();
      videoRepository.findOneBy.mockResolvedValue(null);
      const service = new VideosService(
        videoRepository,
        makeChannelsService() as ChannelsService,
        makeStorageService() as StorageService,
        makeBoss(),
      );

      await expect(
        service.completeUpload('user-id', 'video-id', makeCompleteUploadDto()),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('throws VideoNotOwnedException when the requester does not own the channel', async () => {
      const videoRepository = makeVideoRepository();
      videoRepository.findOneBy.mockResolvedValue(makeVideo());
      const channelsService = makeChannelsService();
      channelsService.findByUserId!.mockResolvedValue(
        makeChannel({ id: 'other-channel-id' }),
      );
      const service = new VideosService(
        videoRepository,
        channelsService as ChannelsService,
        makeStorageService() as StorageService,
        makeBoss(),
      );

      await expect(
        service.completeUpload('user-id', 'video-id', makeCompleteUploadDto()),
      ).rejects.toThrow(VideoNotOwnedException);
    });

    it('throws VideoUploadAlreadyCompletedException when the video is not draft', async () => {
      const videoRepository = makeVideoRepository();
      videoRepository.findOneBy.mockResolvedValue(
        makeVideo({ status: VideoStatus.PROCESSING }),
      );
      const channelsService = makeChannelsService();
      channelsService.findByUserId!.mockResolvedValue(makeChannel());
      const service = new VideosService(
        videoRepository,
        channelsService as ChannelsService,
        makeStorageService() as StorageService,
        makeBoss(),
      );

      await expect(
        service.completeUpload('user-id', 'video-id', makeCompleteUploadDto()),
      ).rejects.toThrow(VideoUploadAlreadyCompletedException);
    });

    it('throws VideoUploadVerificationFailedException when HeadObject fails after completion, without flipping status', async () => {
      const video = makeVideo();
      const videoRepository = makeVideoRepository();
      videoRepository.findOneBy.mockResolvedValue(video);
      const channelsService = makeChannelsService();
      channelsService.findByUserId!.mockResolvedValue(makeChannel());
      const storageService = makeStorageService();
      storageService.completeMultipartUpload!.mockResolvedValue(undefined);
      storageService.verifyObjectExists!.mockResolvedValue(false);
      const service = new VideosService(
        videoRepository,
        channelsService as ChannelsService,
        storageService as StorageService,
        makeBoss(),
      );

      await expect(
        service.completeUpload('user-id', 'video-id', makeCompleteUploadDto()),
      ).rejects.toThrow(VideoUploadVerificationFailedException);
      expect(videoRepository.save).not.toHaveBeenCalled();
    });

    it('completes the upload, flips status to processing, and enqueues a video-processing job', async () => {
      const video = makeVideo();
      const videoRepository = makeVideoRepository();
      videoRepository.findOneBy.mockResolvedValue(video);
      videoRepository.save.mockImplementation((v: Video) => v);
      const channelsService = makeChannelsService();
      channelsService.findByUserId!.mockResolvedValue(makeChannel());
      const storageService = makeStorageService();
      storageService.completeMultipartUpload!.mockResolvedValue(undefined);
      storageService.verifyObjectExists!.mockResolvedValue(true);
      const boss = makeBoss();
      const service = new VideosService(
        videoRepository,
        channelsService as ChannelsService,
        storageService as StorageService,
        boss,
      );

      const dto = makeCompleteUploadDto();
      const result = await service.completeUpload('user-id', video.id, dto);

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        video.storage_key,
        video.upload_id,
        dto.parts,
      );
      expect(videoRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: VideoStatus.PROCESSING }),
      );
      expect(boss.send).toHaveBeenCalledWith(QUEUE_NAMES.VIDEO_PROCESSING, {
        videoId: video.id,
      });
      expect(result).toEqual({ id: video.id, status: VideoStatus.PROCESSING });
    });
  });

  describe('findBySlug', () => {
    it('throws VideoNotFoundException when the slug does not exist', async () => {
      const videoRepository = makeVideoRepository();
      videoRepository.findOneBy.mockResolvedValue(null);
      const service = new VideosService(
        videoRepository,
        makeChannelsService() as ChannelsService,
        makeStorageService() as StorageService,
        makeBoss(),
      );

      await expect(service.findBySlug('unknown-slug')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('returns details for a ready video to an anonymous requester', async () => {
      const video = makeVideo({ status: VideoStatus.READY });
      const videoRepository = makeVideoRepository();
      videoRepository.findOneBy.mockResolvedValue(video);
      const channelsService = makeChannelsService();
      const service = new VideosService(
        videoRepository,
        channelsService as ChannelsService,
        makeStorageService() as StorageService,
        makeBoss(),
      );

      const result = await service.findBySlug(video.slug);

      expect(result).toEqual({
        id: video.id,
        slug: video.slug,
        title: video.title,
        status: VideoStatus.READY,
        durationSeconds: video.duration_seconds,
        createdAt: video.created_at,
      });
      expect(channelsService.findByUserId).not.toHaveBeenCalled();
    });

    it('returns details for a ready video to an authenticated non-owner', async () => {
      const video = makeVideo({ status: VideoStatus.READY });
      const videoRepository = makeVideoRepository();
      videoRepository.findOneBy.mockResolvedValue(video);
      const service = new VideosService(
        videoRepository,
        makeChannelsService() as ChannelsService,
        makeStorageService() as StorageService,
        makeBoss(),
      );

      await expect(
        service.findBySlug(video.slug, 'some-other-user-id'),
      ).resolves.toEqual(expect.objectContaining({ id: video.id }));
    });

    it('throws VideoNotFoundException for a non-ready video requested anonymously', async () => {
      const video = makeVideo({ status: VideoStatus.PROCESSING });
      const videoRepository = makeVideoRepository();
      videoRepository.findOneBy.mockResolvedValue(video);
      const service = new VideosService(
        videoRepository,
        makeChannelsService() as ChannelsService,
        makeStorageService() as StorageService,
        makeBoss(),
      );

      await expect(service.findBySlug(video.slug)).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('throws VideoNotFoundException for a non-ready video requested by a non-owner', async () => {
      const video = makeVideo({ status: VideoStatus.PROCESSING });
      const videoRepository = makeVideoRepository();
      videoRepository.findOneBy.mockResolvedValue(video);
      const channelsService = makeChannelsService();
      channelsService.findByUserId!.mockResolvedValue(
        makeChannel({ id: 'other-channel-id' }),
      );
      const service = new VideosService(
        videoRepository,
        channelsService as ChannelsService,
        makeStorageService() as StorageService,
        makeBoss(),
      );

      await expect(service.findBySlug(video.slug, 'user-id')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('returns details for a non-ready video requested by its owner', async () => {
      const video = makeVideo({ status: VideoStatus.PROCESSING });
      const videoRepository = makeVideoRepository();
      videoRepository.findOneBy.mockResolvedValue(video);
      const channelsService = makeChannelsService();
      channelsService.findByUserId!.mockResolvedValue(makeChannel());
      const service = new VideosService(
        videoRepository,
        channelsService as ChannelsService,
        makeStorageService() as StorageService,
        makeBoss(),
      );

      await expect(service.findBySlug(video.slug, 'user-id')).resolves.toEqual(
        expect.objectContaining({
          id: video.id,
          status: VideoStatus.PROCESSING,
        }),
      );
    });
  });

  describe('getStreamUrl / getDownloadUrl', () => {
    it('getStreamUrl returns a plain presigned URL for a ready video', async () => {
      const video = makeVideo({ status: VideoStatus.READY });
      const videoRepository = makeVideoRepository();
      videoRepository.findOneBy.mockResolvedValue(video);
      const storageService = makeStorageService();
      storageService.getObjectUrl!.mockResolvedValue(
        'https://storage.local/stream',
      );
      const service = new VideosService(
        videoRepository,
        makeChannelsService() as ChannelsService,
        storageService as StorageService,
        makeBoss(),
      );

      const url = await service.getStreamUrl(video.slug);

      expect(storageService.getObjectUrl).toHaveBeenCalledWith(
        video.storage_key,
      );
      expect(url).toBe('https://storage.local/stream');
    });

    it('getDownloadUrl requests an attachment disposition', async () => {
      const video = makeVideo({ status: VideoStatus.READY });
      const videoRepository = makeVideoRepository();
      videoRepository.findOneBy.mockResolvedValue(video);
      const storageService = makeStorageService();
      storageService.getObjectUrl!.mockResolvedValue(
        'https://storage.local/download',
      );
      const service = new VideosService(
        videoRepository,
        makeChannelsService() as ChannelsService,
        storageService as StorageService,
        makeBoss(),
      );

      const url = await service.getDownloadUrl(video.slug);

      expect(storageService.getObjectUrl).toHaveBeenCalledWith(
        video.storage_key,
        expect.objectContaining({ asAttachment: true }),
      );
      expect(url).toBe('https://storage.local/download');
    });

    it('throws VideoNotFoundException for a non-ready video requested anonymously', async () => {
      const video = makeVideo({ status: VideoStatus.DRAFT });
      const videoRepository = makeVideoRepository();
      videoRepository.findOneBy.mockResolvedValue(video);
      const service = new VideosService(
        videoRepository,
        makeChannelsService() as ChannelsService,
        makeStorageService() as StorageService,
        makeBoss(),
      );

      await expect(service.getStreamUrl(video.slug)).rejects.toThrow(
        VideoNotFoundException,
      );
      await expect(service.getDownloadUrl(video.slug)).rejects.toThrow(
        VideoNotFoundException,
      );
    });
  });
});
