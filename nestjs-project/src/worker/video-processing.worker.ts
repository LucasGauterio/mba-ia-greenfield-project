import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import execa from 'execa';
import ffmpegPathRaw from 'ffmpeg-static';
import { path as ffprobePath } from 'ffprobe-static';
import { Repository } from 'typeorm';
import type { VideoProcessingPayload } from '../queue/queue.constants';
import { thumbnailKey } from '../videos/videos.constants';
import { StorageService } from '../videos/storage.service';
import { Video } from '../videos/entities/video.entity';

/** pg-boss `JobWithMetadata` fields the handler relies on (TD-08 / PLAN §11.4). */
export interface VideoProcessingJob {
  data: VideoProcessingPayload;
  retryCount: number;
  retryLimit: number;
}

interface FfprobeStream {
  codec_type?: string;
  [key: string]: unknown;
}

interface FfprobeOutput {
  format?: { duration?: string; [key: string]: unknown };
  streams?: FfprobeStream[];
}

const ERROR_REASON_MAX = 255;

if (!ffmpegPathRaw) {
  throw new Error(
    'ffmpeg-static did not resolve a binary path for this platform',
  );
}
const ffmpegPath: string = ffmpegPathRaw;

/**
 * Consumes `video-processing` jobs: pulls the original from storage, probes it
 * with ffprobe, extracts a thumbnail frame with ffmpeg, writes the thumbnail
 * back, fills the row and moves it to `ready`. On failure it re-throws so
 * pg-boss drives retry/backoff; on the final attempt it first marks the row
 * `error` with a reason (phase-03-videos/TD-05, TD-08).
 */
@Injectable()
export class VideoProcessingWorker {
  private readonly logger = new Logger(VideoProcessingWorker.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {}

  async handleJob(job: VideoProcessingJob): Promise<void> {
    const { videoId } = job.data;
    const isLastAttempt = job.retryCount >= job.retryLimit;
    const workDir = await mkdtemp(join(tmpdir(), `video-${videoId}-`));

    try {
      const video = await this.videoRepository.findOneByOrFail({ id: videoId });

      const originalPath = join(workDir, 'original');
      const thumbPath = join(workDir, 'thumbnail.jpg');

      await this.storageService.downloadObject(video.storage_key, originalPath);

      const { stdout } = await execa(ffprobePath, [
        '-v',
        'error',
        '-show_format',
        '-show_streams',
        '-of',
        'json',
        originalPath,
      ]);
      const probe = JSON.parse(stdout) as FfprobeOutput;
      const durationSeconds = Math.round(Number(probe.format?.duration ?? 0));

      // PLAN §11.4: -ss 0 (never -ss 1 — silently no-ops on sub-1s clips).
      await execa(ffmpegPath, [
        '-ss',
        '0',
        '-i',
        originalPath,
        '-frames:v',
        '1',
        '-q:v',
        '2',
        '-y',
        thumbPath,
      ]);

      const tKey = thumbnailKey(videoId);
      await this.storageService.uploadObject(tKey, thumbPath, 'image/jpeg');

      video.duration_seconds = Number.isFinite(durationSeconds)
        ? durationSeconds
        : null;
      video.metadata = {
        format: probe.format ?? null,
        streams: probe.streams ?? [],
      };
      video.thumbnail_key = tKey;
      video.error_reason = null;
      video.status = 'ready';
      await this.videoRepository.save(video);

      this.logger.log(`Video ${videoId} processed -> ready`);
    } catch (err) {
      if (isLastAttempt) {
        await this.videoRepository.update(
          { id: videoId },
          {
            status: 'error',
            error_reason: String(err).slice(0, ERROR_REASON_MAX),
          },
        );
        this.logger.error(
          `Video ${videoId} failed on the final attempt -> error`,
        );
      }
      throw err;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
