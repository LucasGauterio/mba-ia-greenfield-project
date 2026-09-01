import { Repository } from 'typeorm';
import { StorageService } from '../videos/storage.service';
import { Video } from '../videos/entities/video.entity';
import { VideoProcessingWorker } from './video-processing.worker';
import type { VideoProcessingJob } from './video-processing.worker';

describe('VideoProcessingWorker', () => {
  let worker: VideoProcessingWorker;
  let videoRepo: {
    findOneByOrFail: jest.Mock<Promise<Partial<Video>>>;
    save: jest.Mock<Promise<Partial<Video>>, [Partial<Video>]>;
    update: jest.Mock<Promise<unknown>, [object, Record<string, unknown>]>;
  };
  let storage: { downloadObject: jest.Mock; uploadObject: jest.Mock };

  const job = (retryCount: number, retryLimit = 3): VideoProcessingJob => ({
    data: { videoId: 'video-1' },
    retryCount,
    retryLimit,
  });

  beforeEach(() => {
    videoRepo = {
      findOneByOrFail: jest.fn(() =>
        Promise.resolve({
          id: 'video-1',
          storage_key: 'videos/video-1/original.mp4',
        }),
      ),
      save: jest.fn((v: Partial<Video>) => Promise.resolve(v)),
      update: jest.fn<Promise<unknown>, [object, Record<string, unknown>]>(() =>
        Promise.resolve({ affected: 1 }),
      ),
    };
    // Fail before ffprobe/ffmpeg are ever invoked.
    storage = {
      downloadObject: jest.fn(() => Promise.reject(new Error('storage down'))),
      uploadObject: jest.fn(() => Promise.resolve()),
    };

    worker = new VideoProcessingWorker(
      videoRepo as unknown as Repository<Video>,
      storage as unknown as StorageService,
    );
  });

  it('marks the row error with a reason and re-throws on the final attempt', async () => {
    await expect(worker.handleJob(job(3))).rejects.toThrow('storage down');

    expect(videoRepo.update).toHaveBeenCalledTimes(1);
    const [criteria, patch] = videoRepo.update.mock.calls[0];
    expect(criteria).toEqual({ id: 'video-1' });
    expect(patch.status).toBe('error');
    expect(typeof patch.error_reason).toBe('string');
    expect((patch.error_reason as string).length).toBeGreaterThan(0);
  });

  it('only re-throws on a non-final attempt, leaving the row untouched', async () => {
    await expect(worker.handleJob(job(0))).rejects.toThrow('storage down');

    expect(videoRepo.update).not.toHaveBeenCalled();
    expect(videoRepo.save).not.toHaveBeenCalled();
  });
});
