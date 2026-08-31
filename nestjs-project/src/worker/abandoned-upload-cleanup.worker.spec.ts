import { createMock } from '@golevelup/ts-jest';
import type { Repository } from 'typeorm';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import type { StorageService } from '../videos/storage.service';
import { AbandonedUploadCleanupWorker } from './abandoned-upload-cleanup.worker';

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

function makeVideoRepository(): jest.Mocked<Repository<Video>> {
  return createMock<Repository<Video>>();
}

function makeStorageService(): jest.Mocked<StorageService> {
  return createMock<StorageService>();
}

describe('AbandonedUploadCleanupWorker', () => {
  describe('process', () => {
    it('does nothing when there are no stale drafts', async () => {
      const videoRepository = makeVideoRepository();
      videoRepository.findBy.mockResolvedValue([]);
      const storageService = makeStorageService();
      const worker = new AbandonedUploadCleanupWorker(
        videoRepository,
        storageService,
      );

      await worker.process();

      expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
      expect(videoRepository.save).not.toHaveBeenCalled();
    });

    it('aborts the multipart upload and flips each stale draft to error', async () => {
      const videoA = makeVideo({ id: 'video-a', upload_id: 'upload-a' });
      const videoB = makeVideo({ id: 'video-b', upload_id: 'upload-b' });
      const videoRepository = makeVideoRepository();
      videoRepository.findBy.mockResolvedValue([videoA, videoB]);
      const storageService = makeStorageService();
      const worker = new AbandonedUploadCleanupWorker(
        videoRepository,
        storageService,
      );

      await worker.process();

      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        videoA.storage_key,
        'upload-a',
      );
      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        videoB.storage_key,
        'upload-b',
      );
      expect(videoRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'video-a',
          status: VideoStatus.ERROR,
          error_reason: 'upload_abandoned_ttl_exceeded',
        }),
      );
      expect(videoRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'video-b',
          status: VideoStatus.ERROR,
          error_reason: 'upload_abandoned_ttl_exceeded',
        }),
      );
    });

    it('flips status to error without aborting when upload_id is missing', async () => {
      const video = makeVideo({ upload_id: null });
      const videoRepository = makeVideoRepository();
      videoRepository.findBy.mockResolvedValue([video]);
      const storageService = makeStorageService();
      const worker = new AbandonedUploadCleanupWorker(
        videoRepository,
        storageService,
      );

      await worker.process();

      expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
      expect(videoRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: VideoStatus.ERROR }),
      );
    });
  });

  describe('handleJob', () => {
    it('delegates to process', async () => {
      const videoRepository = makeVideoRepository();
      videoRepository.findBy.mockResolvedValue([]);
      const worker = new AbandonedUploadCleanupWorker(
        videoRepository,
        makeStorageService(),
      );
      const processSpy = jest.spyOn(worker, 'process');

      await worker.handleJob();

      expect(processSpy).toHaveBeenCalledTimes(1);
    });
  });
});
