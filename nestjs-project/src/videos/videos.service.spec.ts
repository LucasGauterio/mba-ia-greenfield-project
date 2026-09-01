import { DatabaseError } from 'pg';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import {
  VideoFileTooLargeException,
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoUploadAlreadyCompletedException,
  VideoUploadVerificationFailedException,
} from '../common/exceptions/domain.exception';
import { QueueService } from '../queue/queue.service';
import type { CompletedPartDto } from './dto/complete-upload.dto';
import type { CreateVideoDto } from './dto/create-video.dto';
import { Video } from './entities/video.entity';
import { StorageService } from './storage.service';
import { MAX_UPLOAD_BYTES } from './videos.constants';
import { VideosService } from './videos.service';

function slugUniqueViolation(): QueryFailedError<DatabaseError> {
  const driverError = new DatabaseError('duplicate key', 0, 'error');
  const mutable = driverError as { code?: string; detail?: string };
  mutable.code = '23505';
  mutable.detail = 'Key (slug)=(abcdefghij) already exists.';
  return new QueryFailedError<DatabaseError>(
    'INSERT INTO videos',
    [],
    driverError,
  );
}

describe('VideosService', () => {
  let service: VideosService;
  let videoRepo: {
    create: jest.Mock<Partial<Video>, [Partial<Video>]>;
    save: jest.Mock<Promise<Video>, [Video]>;
    findOne: jest.Mock<Promise<Video | null>>;
    find: jest.Mock<Promise<Video[]>, [{ where: Record<string, unknown> }]>;
  };
  let channelRepo: { findOne: jest.Mock<Promise<{ id: string } | null>> };
  let storage: {
    createMultipartUpload: jest.Mock<Promise<string>>;
    presignUploadPart: jest.Mock<Promise<string>, [string, string, number]>;
    completeMultipartUpload: jest.Mock<Promise<void>>;
    headObject: jest.Mock<Promise<{ contentLength: number }>>;
    presignGetObject: jest.Mock<Promise<string>, [string, unknown?]>;
    abortMultipartUpload: jest.Mock<Promise<void>, [string, string]>;
  };
  let queue: {
    publishVideoProcessing: jest.Mock<Promise<void>, [string, unknown?]>;
  };
  let manager: {
    save: jest.Mock<Promise<unknown>, [unknown]>;
    query: jest.Mock<Promise<unknown[]>>;
  };
  let dataSource: { transaction: jest.Mock };

  const dto: CreateVideoDto = {
    fileName: 'clip.mp4',
    fileSize: 20 * 1024 ** 2,
    contentType: 'video/mp4',
  };

  const parts: CompletedPartDto[] = [{ partNumber: 1, eTag: 'etag-1' }];

  function draftVideo(overrides: Partial<Video> = {}): Video {
    return {
      id: 'video-1',
      channel_id: 'channel-1',
      slug: 'abcdefghij',
      status: 'draft',
      storage_key: 'videos/video-1/original.mp4',
      upload_id: 'upload-xyz',
      channel: { user_id: 'user-1' } as Channel,
      ...overrides,
    } as Video;
  }

  beforeEach(() => {
    videoRepo = {
      create: jest.fn((v: Partial<Video>) => v),
      save: jest.fn((v: Video) => Promise.resolve(v)),
      findOne: jest.fn(() => Promise.resolve(null)),
      find: jest.fn<Promise<Video[]>, [{ where: Record<string, unknown> }]>(
        () => Promise.resolve([]),
      ),
    };
    channelRepo = {
      findOne: jest.fn(() => Promise.resolve({ id: 'channel-1' })),
    };
    storage = {
      createMultipartUpload: jest.fn(() => Promise.resolve('upload-xyz')),
      presignUploadPart: jest.fn((_k, _u, n) =>
        Promise.resolve(`https://minio/part/${n}`),
      ),
      completeMultipartUpload: jest.fn(() => Promise.resolve()),
      headObject: jest.fn(() => Promise.resolve({ contentLength: 1024 })),
      presignGetObject: jest.fn((key: string) =>
        Promise.resolve(`https://minio/get/${key}`),
      ),
      abortMultipartUpload: jest.fn<Promise<void>, [string, string]>(() =>
        Promise.resolve(),
      ),
    };
    queue = {
      publishVideoProcessing: jest.fn<Promise<void>, [string, unknown?]>(() =>
        Promise.resolve(),
      ),
    };
    manager = {
      save: jest.fn((v: unknown) => Promise.resolve(v)),
      query: jest.fn(() => Promise.resolve([] as unknown[])),
    };
    dataSource = {
      transaction: jest.fn((cb: (m: typeof manager) => unknown) => cb(manager)),
    };

    service = new VideosService(
      videoRepo as unknown as Repository<Video>,
      channelRepo as unknown as Repository<Channel>,
      storage as unknown as StorageService,
      queue as unknown as QueueService,
      dataSource as unknown as DataSource,
    );
  });

  it('rejects a file above the size limit before touching storage or the DB', async () => {
    await expect(
      service.initiateUpload('user-1', {
        ...dto,
        fileSize: MAX_UPLOAD_BYTES + 1,
      }),
    ).rejects.toBeInstanceOf(VideoFileTooLargeException);

    expect(channelRepo.findOne).not.toHaveBeenCalled();
    expect(storage.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('retries slug generation on a unique-violation and eventually succeeds', async () => {
    videoRepo.save
      .mockRejectedValueOnce(slugUniqueViolation())
      .mockImplementation((v: Video) => Promise.resolve(v));

    const result = await service.initiateUpload('user-1', dto);

    // create() called at least twice (one collision + one success) with
    // different slugs.
    expect(videoRepo.create.mock.calls.length).toBeGreaterThanOrEqual(2);
    const slugs = videoRepo.create.mock.calls.map((call) => call[0].slug);
    expect(slugs[0]).not.toBe(slugs[1]);
    expect(result.slug).toHaveLength(10);
  });

  it('persists a draft with the upload id and returns presigned parts', async () => {
    const result = await service.initiateUpload('user-1', dto);

    const firstDraft = videoRepo.create.mock.calls[0][0];
    expect(firstDraft.status).toBe('draft');
    expect(firstDraft.channel_id).toBe('channel-1');
    expect(firstDraft.storage_key).toMatch(
      /^videos\/[0-9a-f-]+\/original\.mp4$/,
    );

    // The row is saved a second time carrying the storage upload id.
    const savedWithUploadId = videoRepo.save.mock.calls
      .map((call) => call[0])
      .find((v) => v.upload_id === 'upload-xyz');
    expect(savedWithUploadId).toBeDefined();

    expect(result.status).toBe('draft');
    expect(result.uploadId).toBe('upload-xyz');
    expect(result.parts).toEqual([
      { partNumber: 1, url: 'https://minio/part/1' },
    ]);
  });

  it('rethrows a non-unique-violation error from save', async () => {
    videoRepo.save.mockRejectedValue(new Error('connection reset'));

    await expect(service.initiateUpload('user-1', dto)).rejects.toThrow(
      'connection reset',
    );
  });

  describe('completeUpload', () => {
    it('completes the multipart, flips the row and enqueues processing for the owner', async () => {
      videoRepo.findOne.mockResolvedValue(draftVideo());

      const result = await service.completeUpload('video-1', 'user-1', parts);

      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/original.mp4',
        'upload-xyz',
        [{ PartNumber: 1, ETag: 'etag-1' }],
      );
      expect(storage.headObject).toHaveBeenCalledWith(
        'videos/video-1/original.mp4',
      );

      const saved = manager.save.mock.calls[0][0] as Video;
      expect(saved.status).toBe('processing');
      expect(saved.upload_id).toBeNull();

      expect(queue.publishVideoProcessing).toHaveBeenCalledTimes(1);
      expect(queue.publishVideoProcessing.mock.calls[0][0]).toBe('video-1');

      expect(result).toEqual({ id: 'video-1', status: 'processing' });
    });

    it('throws VIDEO_NOT_FOUND when the video does not exist', async () => {
      videoRepo.findOne.mockResolvedValue(null);

      await expect(
        service.completeUpload('missing', 'user-1', parts),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('throws VIDEO_NOT_OWNED when the caller does not own the channel', async () => {
      videoRepo.findOne.mockResolvedValue(
        draftVideo({ channel: { user_id: 'someone-else' } as Channel }),
      );

      await expect(
        service.completeUpload('video-1', 'user-1', parts),
      ).rejects.toBeInstanceOf(VideoNotOwnedException);
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('throws VIDEO_UPLOAD_ALREADY_COMPLETED when the video is not draft', async () => {
      videoRepo.findOne.mockResolvedValue(
        draftVideo({ status: 'processing', upload_id: null }),
      );

      await expect(
        service.completeUpload('video-1', 'user-1', parts),
      ).rejects.toBeInstanceOf(VideoUploadAlreadyCompletedException);
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('throws VIDEO_UPLOAD_VERIFICATION_FAILED when headObject fails after a successful complete', async () => {
      videoRepo.findOne.mockResolvedValue(draftVideo());
      storage.headObject.mockRejectedValue(new Error('404 NotFound'));

      await expect(
        service.completeUpload('video-1', 'user-1', parts),
      ).rejects.toBeInstanceOf(VideoUploadVerificationFailedException);

      expect(storage.completeMultipartUpload).toHaveBeenCalledTimes(1);
      expect(queue.publishVideoProcessing).not.toHaveBeenCalled();
    });
  });

  describe('read visibility (getVideoBySlug)', () => {
    function readyVideo(overrides: Partial<Video> = {}): Video {
      return {
        id: 'video-9',
        slug: 'readyslug1',
        title: 'A clip',
        status: 'ready',
        storage_key: 'videos/video-9/original.mp4',
        thumbnail_key: 'videos/video-9/thumbnail.jpg',
        duration_seconds: 12,
        channel: { user_id: 'owner-1', nickname: 'owner' } as Channel,
        ...overrides,
      } as Video;
    }

    it('returns the public view of a ready video to an anonymous caller', async () => {
      videoRepo.findOne.mockResolvedValue(readyVideo());

      const view = await service.getVideoBySlug('readyslug1');

      expect(view).toEqual({
        slug: 'readyslug1',
        title: 'A clip',
        status: 'ready',
        durationSeconds: 12,
        thumbnailUrl: 'https://minio/get/videos/video-9/thumbnail.jpg',
        channel: { nickname: 'owner' },
      });
    });

    it('hides a non-ready video from an anonymous caller (VIDEO_NOT_FOUND)', async () => {
      videoRepo.findOne.mockResolvedValue(readyVideo({ status: 'processing' }));

      await expect(service.getVideoBySlug('readyslug1')).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
    });

    it('hides a non-ready video from an authenticated non-owner', async () => {
      videoRepo.findOne.mockResolvedValue(readyVideo({ status: 'error' }));

      await expect(
        service.getVideoBySlug('readyslug1', 'someone-else'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('shows a non-ready video to its owner', async () => {
      videoRepo.findOne.mockResolvedValue(readyVideo({ status: 'processing' }));

      const view = await service.getVideoBySlug('readyslug1', 'owner-1');

      expect(view.status).toBe('processing');
    });
  });

  describe('sweepAbandonedUploads', () => {
    it('aborts the multipart and moves each stale draft to error', async () => {
      const stale = draftVideo({
        id: 'stale-1',
        storage_key: 'videos/stale-1/original.mp4',
        upload_id: 'stale-upload',
      });
      videoRepo.find.mockResolvedValue([stale]);

      const result = await service.sweepAbandonedUploads();

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/stale-1/original.mp4',
        'stale-upload',
      );
      const saved = videoRepo.save.mock.calls[0][0];
      expect(saved.status).toBe('error');
      expect(saved.error_reason).toBe('upload_abandoned_ttl_exceeded');
      expect(saved.upload_id).toBeNull();
      expect(result.swept).toBe(1);
    });

    it('queries only draft rows older than the TTL', async () => {
      await service.sweepAbandonedUploads();

      const { where } = videoRepo.find.mock.calls[0][0];
      expect(where.status).toBe('draft');
      expect(where.created_at).toBeDefined();
    });

    it('keeps going when one row fails, and does not count it', async () => {
      videoRepo.find.mockResolvedValue([
        draftVideo({ id: 'bad', upload_id: 'u1' }),
        draftVideo({ id: 'good', upload_id: 'u2' }),
      ]);
      storage.abortMultipartUpload.mockRejectedValueOnce(new Error('boom'));

      const result = await service.sweepAbandonedUploads();

      expect(result.swept).toBe(1);
    });
  });
});
