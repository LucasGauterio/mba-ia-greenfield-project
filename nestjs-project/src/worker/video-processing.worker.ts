import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { extname, join } from 'path';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import execa from 'execa';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import type { JobWithMetadata } from 'pg-boss';
import { Repository } from 'typeorm';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { StorageService } from '../videos/storage.service';

// Seeking to a fixed later offset (e.g. "1") fails silently — ffmpeg exits 0
// but writes no frame — for videos shorter than that offset. "0" always has
// a frame to extract regardless of video length.
const THUMBNAIL_TIMESTAMP_SECONDS = '0';
const ERROR_REASON_MAX_LENGTH = 255;

export interface VideoProcessingJobData {
  videoId: string;
}

@Injectable()
export class VideoProcessingWorker {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {}

  async handleJob(job: JobWithMetadata<VideoProcessingJobData>): Promise<void> {
    try {
      await this.process(job.data.videoId);
    } catch (err) {
      if (job.retryCount >= job.retryLimit) {
        await this.markFailed(job.data.videoId, err);
      }
      throw err;
    }
  }

  async process(videoId: string): Promise<void> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      throw new Error(`Video ${videoId} not found`);
    }

    const workDir = await mkdtemp(join(tmpdir(), 'video-processing-'));
    const inputPath = join(workDir, `input${extname(video.storage_key)}`);
    const thumbnailPath = join(workDir, 'thumbnail.jpg');

    try {
      await this.storageService.downloadObject(video.storage_key, inputPath);

      const metadata = await this.extractMetadata(inputPath);
      await this.generateThumbnail(inputPath, thumbnailPath);

      const thumbnailKey = `videos/${video.id}/thumbnail.jpg`;
      await this.storageService.uploadObject(
        thumbnailKey,
        thumbnailPath,
        'image/jpeg',
      );

      video.duration_seconds = extractDurationSeconds(metadata);
      video.metadata = metadata;
      video.thumbnail_key = thumbnailKey;
      video.status = VideoStatus.READY;
      video.error_reason = null;
      await this.videoRepository.save(video);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  async markFailed(videoId: string, error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    await this.videoRepository.update(
      { id: videoId },
      {
        status: VideoStatus.ERROR,
        error_reason: reason.slice(0, ERROR_REASON_MAX_LENGTH),
      },
    );
  }

  private async extractMetadata(
    inputPath: string,
  ): Promise<Record<string, unknown>> {
    const { stdout } = await execa(ffprobeStatic.path, [
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      inputPath,
    ]);
    return JSON.parse(stdout) as Record<string, unknown>;
  }

  private async generateThumbnail(
    inputPath: string,
    outputPath: string,
  ): Promise<void> {
    if (!ffmpegPath) {
      throw new Error('ffmpeg binary not available for this platform');
    }
    await execa(ffmpegPath, [
      '-ss',
      THUMBNAIL_TIMESTAMP_SECONDS,
      '-i',
      inputPath,
      '-frames:v',
      '1',
      outputPath,
    ]);
  }
}

function extractDurationSeconds(
  metadata: Record<string, unknown>,
): number | null {
  const format = metadata.format as Record<string, unknown> | undefined;
  const duration = format?.duration;
  if (typeof duration !== 'string' && typeof duration !== 'number') {
    return null;
  }
  const parsed = Number(duration);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}
