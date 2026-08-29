import { createMock } from '@golevelup/ts-jest';
import type { PgBoss } from 'pg-boss';
import { QueryFailedError, Repository } from 'typeorm';
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
  return Object.assign(
    new QueryFailedError('INSERT', [], new Error('duplicate key')),
    { code: '23505', detail: 'Key (slug)=(abc1234567) already exists.' },
  );
}

function makeVideoRepository(): jest.Mocked<Repository<Video>> {
  const repo = createMock<Repository<Video>>();
  repo.create.mockImplementation((entityLike?: unknown) => entityLike as Video);
  return repo;
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
      const channelsService = createMock<ChannelsService>();
      const service = new VideosService(
        makeVideoRepository(),
        channelsService,
        createMock<StorageService>(),
        createMock<PgBoss>(),
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
      const channelsService = createMock<ChannelsService>();
      channelsService.findByUserId.mockResolvedValue(null);
      const service = new VideosService(
        makeVideoRepository(),
        channelsService,
        createMock<StorageService>(),
        createMock<PgBoss>(),
      );

      await expect(
        service.initiateUpload('user-id', makeDto()),
      ).rejects.toThrow('Channel not found for authenticated user');
    });

    it('creates a multipart upload and returns presigned parts for a valid request', async () => {
      const channel = makeChannel();
      const channelsService = createMock<ChannelsService>();
      channelsService.findByUserId.mockResolvedValue(channel);

      const storageService = createMock<StorageService>();
      storageService.createMultipartUpload.mockResolvedValue('upload-123');
      storageService.getUploadPartUrl.mockImplementation(
        (_key, _uploadId, partNumber) =>
          Promise.resolve(`https://storage.local/part-${String(partNumber)}`),
      );

      const videoRepository = makeVideoRepository();
      videoRepository.save.mockImplementation((entityLike) =>
        Promise.resolve(makeVideo(entityLike as Partial<Video>)),
      );

      const service = new VideosService(
        videoRepository,
        channelsService,
        storageService,
        createMock<PgBoss>(),
      );

      const result = await service.initiateUpload(
        'user-id',
        makeDto({ fileSize: 30 * 1024 ** 2 }), // 30MB -> 2 parts of 25MB
      );

      const [storageKey, contentType] =
        storageService.createMultipartUpload.mock.calls[0];
      expect(storageKey).toMatch(/^videos\/.+\/original\.mp4$/);
      expect(contentType).toBe('video/mp4');
      expect(result.uploadId).toBe('upload-123');
      expect(result.parts).toEqual([
        { partNumber: 1, uploadUrl: 'https://storage.local/part-1' },
        { partNumber: 2, uploadUrl: 'https://storage.local/part-2' },
      ]);
      const createArg = videoRepository.create.mock
        .calls[0][0] as Partial<Video>;
      expect(createArg.channel_id).toBe(channel.id);
      expect(createArg.storage_key).toMatch(/^videos\/.+\/original\.mp4$/);
      expect(createArg.upload_id).toBe('upload-123');
    });

    it('generates a fresh slug and retries when the DB reports a unique constraint violation', async () => {
      const channel = makeChannel();
      const channelsService = createMock<ChannelsService>();
      channelsService.findByUserId.mockResolvedValue(channel);

      const storageService = createMock<StorageService>();
      storageService.createMultipartUpload.mockResolvedValue('upload-123');
      storageService.getUploadPartUrl.mockResolvedValue(
        'https://storage.local/part-1',
      );

      const videoRepository = makeVideoRepository();
      videoRepository.save
        .mockRejectedValueOnce(makeUniqueSlugError())
        .mockImplementationOnce((entityLike) =>
          Promise.resolve(makeVideo(entityLike as Partial<Video>)),
        );

      const service = new VideosService(
        videoRepository,
        channelsService,
        storageService,
        createMock<PgBoss>(),
      );

      const result = await service.initiateUpload('user-id', makeDto());

      expect(videoRepository.save).toHaveBeenCalledTimes(2);
      const [firstAttempt, secondAttempt] =
        videoRepository.create.mock.calls.map(
          (call) => (call[0] as Partial<Video>).slug,
        );
      expect(firstAttempt).not.toBe(secondAttempt);
      expect(result.slug).toBeDefined();
    });

    it('throws after exhausting max slug retries', async () => {
      const channel = makeChannel();
      const channelsService = createMock<ChannelsService>();
      channelsService.findByUserId.mockResolvedValue(channel);

      const storageService = createMock<StorageService>();
      storageService.createMultipartUpload.mockResolvedValue('upload-123');
      storageService.getUploadPartUrl.mockResolvedValue(
        'https://storage.local/part-1',
      );

      const videoRepository = makeVideoRepository();
      videoRepository.save.mockRejectedValue(makeUniqueSlugError());

      const service = new VideosService(
        videoRepository,
        channelsService,
        storageService,
        createMock<PgBoss>(),
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
        createMock<ChannelsService>(),
        createMock<StorageService>(),
        createMock<PgBoss>(),
      );

      await expect(
        service.completeUpload('user-id', 'video-id', makeCompleteUploadDto()),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('throws VideoNotOwnedException when the requester does not own the channel', async () => {
      const videoRepository = makeVideoRepository();
      videoRepository.findOneBy.mockResolvedValue(makeVideo());
      const channelsService = createMock<ChannelsService>();
      channelsService.findByUserId.mockResolvedValue(
        makeChannel({ id: 'other-channel-id' }),
      );
      const service = new VideosService(
        videoRepository,
        channelsService,
        createMock<StorageService>(),
        createMock<PgBoss>(),
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
      const channelsService = createMock<ChannelsService>();
      channelsService.findByUserId.mockResolvedValue(makeChannel());
      const service = new VideosService(
        videoRepository,
        channelsService,
        createMock<StorageService>(),
        createMock<PgBoss>(),
      );

      await expect(
        service.completeUpload('user-id', 'video-id', makeCompleteUploadDto()),
      ).rejects.toThrow(VideoUploadAlreadyCompletedException);
    });

    it('throws VideoUploadVerificationFailedException when HeadObject fails after completion, without flipping status', async () => {
      const video = makeVideo();
      const videoRepository = makeVideoRepository();
      videoRepository.findOneBy.mockResolvedValue(video);
      const channelsService = createMock<ChannelsService>();
      channelsService.findByUserId.mockResolvedValue(makeChannel());
      const storageService = createMock<StorageService>();
      storageService.completeMultipartUpload.mockResolvedValue(undefined);
      storageService.verifyObjectExists.mockResolvedValue(false);
      const service = new VideosService(
        videoRepository,
        channelsService,
        storageService,
        createMock<PgBoss>(),
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
      videoRepository.save.mockImplementation((v) =>
        Promise.resolve(v as Video),
      );
      const channelsService = createMock<ChannelsService>();
      channelsService.findByUserId.mockResolvedValue(makeChannel());
      const storageService = createMock<StorageService>();
      storageService.completeMultipartUpload.mockResolvedValue(undefined);
      storageService.verifyObjectExists.mockResolvedValue(true);
      const boss = createMock<PgBoss>();
      const service = new VideosService(
        videoRepository,
        channelsService,
        storageService,
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
});
