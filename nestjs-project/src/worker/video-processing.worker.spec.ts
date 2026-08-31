import { createMock } from '@golevelup/ts-jest';
import execa from 'execa';
import type { JobWithMetadata } from 'pg-boss';
import type { Repository } from 'typeorm';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import type { StorageService } from '../videos/storage.service';
import {
  VideoProcessingJobData,
  VideoProcessingWorker,
} from './video-processing.worker';

jest.mock('execa');

// `typeof execa` is a heavily overloaded callable; `jest.MockedFunction` resolves
// it to the `Buffer` encoding overload, which fights the `string` stdout the
// worker actually consumes. Narrow to the single signature this suite exercises.
const mockedExeca = execa as unknown as jest.MockedFunction<
  () => Promise<execa.ExecaReturnValue>
>;

function makeVideo(overrides: Partial<Video> = {}): Video {
  const v = new Video();
  v.id = 'video-id';
  v.channel_id = 'channel-id';
  v.slug = 'abc1234567';
  v.title = null;
  v.status = VideoStatus.PROCESSING;
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

function makeFfprobeResult(stdout: string): execa.ExecaReturnValue {
  return createMock<execa.ExecaReturnValue>({ stdout });
}

function makeJob(
  overrides: Partial<JobWithMetadata<VideoProcessingJobData>> = {},
): JobWithMetadata<VideoProcessingJobData> {
  return {
    id: 'job-id',
    name: 'video-processing',
    data: { videoId: 'video-id' },
    retryCount: 0,
    retryLimit: 3,
    ...overrides,
  } as JobWithMetadata<VideoProcessingJobData>;
}

const FFPROBE_OUTPUT = JSON.stringify({
  format: { duration: '12.345', size: '1024' },
  streams: [{ codec_type: 'video', width: 1920, height: 1080 }],
});

describe('VideoProcessingWorker', () => {
  beforeEach(() => {
    mockedExeca.mockReset();
  });

  describe('process', () => {
    it('throws when the video does not exist', async () => {
      const videoRepository = makeVideoRepository();
      videoRepository.findOneBy.mockResolvedValue(null);
      const worker = new VideoProcessingWorker(
        videoRepository,
        makeStorageService(),
      );

      await expect(worker.process('missing-id')).rejects.toThrow(
        'Video missing-id not found',
      );
    });

    it('extracts metadata, generates a thumbnail, and flips status to ready', async () => {
      const video = makeVideo();
      const videoRepository = makeVideoRepository();
      videoRepository.findOneBy.mockResolvedValue(video);
      const storageService = makeStorageService();
      mockedExeca.mockResolvedValue(makeFfprobeResult(FFPROBE_OUTPUT));

      const worker = new VideoProcessingWorker(videoRepository, storageService);

      await worker.process(video.id);

      expect(storageService.downloadObject).toHaveBeenCalledWith(
        video.storage_key,
        expect.stringContaining('input.mp4'),
      );
      expect(storageService.uploadObject).toHaveBeenCalledWith(
        `videos/${video.id}/thumbnail.jpg`,
        expect.stringContaining('thumbnail.jpg'),
        'image/jpeg',
      );
      expect(videoRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: VideoStatus.READY,
          duration_seconds: 12,
          thumbnail_key: `videos/${video.id}/thumbnail.jpg`,
        }),
      );
      expect(video.metadata).toEqual(JSON.parse(FFPROBE_OUTPUT));
    });

    it('propagates the error when ffprobe fails, without updating the video', async () => {
      const video = makeVideo();
      const videoRepository = makeVideoRepository();
      videoRepository.findOneBy.mockResolvedValue(video);
      const storageService = makeStorageService();
      mockedExeca.mockRejectedValue(new Error('ffprobe crashed'));

      const worker = new VideoProcessingWorker(videoRepository, storageService);

      await expect(worker.process(video.id)).rejects.toThrow('ffprobe crashed');
      expect(videoRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('markFailed', () => {
    it('sets status to error with a truncated error_reason', async () => {
      const videoRepository = makeVideoRepository();
      const worker = new VideoProcessingWorker(
        videoRepository,
        makeStorageService(),
      );

      await worker.markFailed('video-id', new Error('boom'));

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'video-id' },
        { status: VideoStatus.ERROR, error_reason: 'boom' },
      );
    });
  });

  describe('handleJob', () => {
    it('does not mark the video failed when retries remain', async () => {
      const videoRepository = makeVideoRepository();
      videoRepository.findOneBy.mockResolvedValue(null); // forces process() to throw
      const worker = new VideoProcessingWorker(
        videoRepository,
        makeStorageService(),
      );
      jest.spyOn(worker, 'markFailed').mockResolvedValue(undefined);

      await expect(
        worker.handleJob(makeJob({ retryCount: 0, retryLimit: 3 })),
      ).rejects.toThrow('Video video-id not found');
      expect(worker.markFailed).not.toHaveBeenCalled();
    });

    it('marks the video failed on the final retry attempt, then rethrows', async () => {
      const videoRepository = makeVideoRepository();
      videoRepository.findOneBy.mockResolvedValue(null);
      const worker = new VideoProcessingWorker(
        videoRepository,
        makeStorageService(),
      );
      jest.spyOn(worker, 'markFailed').mockResolvedValue(undefined);

      await expect(
        worker.handleJob(makeJob({ retryCount: 3, retryLimit: 3 })),
      ).rejects.toThrow('Video video-id not found');
      expect(worker.markFailed).toHaveBeenCalledWith(
        'video-id',
        expect.any(Error),
      );
    });

    it('does not call markFailed on success', async () => {
      const video = makeVideo();
      const videoRepository = makeVideoRepository();
      videoRepository.findOneBy.mockResolvedValue(video);
      mockedExeca.mockResolvedValue(makeFfprobeResult(FFPROBE_OUTPUT));
      const worker = new VideoProcessingWorker(
        videoRepository,
        makeStorageService(),
      );
      jest.spyOn(worker, 'markFailed').mockResolvedValue(undefined);

      await worker.handleJob(makeJob({ retryCount: 0, retryLimit: 3 }));

      expect(worker.markFailed).not.toHaveBeenCalled();
    });
  });
});
