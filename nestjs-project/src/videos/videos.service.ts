import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { nanoid } from 'nanoid';
import { DataSource, LessThan, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { isUniqueViolation } from '../common/database/postgres-error';
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
import { Video, VideoStatus } from './entities/video.entity';
import { StorageService } from './storage.service';
import {
  ABANDONED_UPLOAD_ERROR_REASON,
  ABANDONED_UPLOAD_TTL_HOURS,
  MAX_UPLOAD_BYTES,
  extensionOf,
  originalKey,
  partCount,
} from './videos.constants';

const HOUR_MS = 60 * 60 * 1000;

const SLUG_LENGTH = 10;
const MAX_SLUG_RETRIES = 5;

export interface UploadPart {
  partNumber: number;
  url: string;
}

export interface InitiateUploadResult {
  id: string;
  slug: string;
  status: VideoStatus;
  uploadId: string;
  parts: UploadPart[];
}

export interface CompleteUploadResult {
  id: string;
  status: VideoStatus;
}

export interface VideoView {
  slug: string;
  title: string | null;
  status: VideoStatus;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  channel: { nickname: string };
}

/** Filesystem-safe base name for a download filename (no path chars, no quotes). */
function sanitizeFilename(rawName: string): string {
  const collapsed = rawName.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '');
  return collapsed.length > 0 ? collapsed.slice(0, 100) : 'video';
}

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @InjectRepository(Channel)
    private readonly channelRepository: Repository<Channel>,
    private readonly storageService: StorageService,
    private readonly queueService: QueueService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Pre-registers a `draft` video on the caller's channel, opens an S3
   * multipart upload and returns one presigned `UploadPart` URL per part. The
   * file itself never transits the API (phase-03-videos/TD-02).
   */
  async initiateUpload(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<InitiateUploadResult> {
    if (dto.fileSize > MAX_UPLOAD_BYTES) {
      throw new VideoFileTooLargeException();
    }

    const channel = await this.channelRepository.findOne({
      where: { user_id: userId },
    });
    if (!channel) {
      throw new Error(`Authenticated user ${userId} has no channel`);
    }

    const id = randomUUID();
    const storageKey = originalKey(id, extensionOf(dto.fileName));

    const video = await this.persistDraft(
      id,
      channel.id,
      storageKey,
      dto.title,
    );

    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      dto.contentType,
    );
    video.upload_id = uploadId;
    await this.videoRepository.save(video);

    const parts = await this.presignParts(storageKey, uploadId, dto.fileSize);

    return {
      id: video.id,
      slug: video.slug,
      status: video.status,
      uploadId,
      parts,
    };
  }

  /**
   * Confirms a client-completed multipart upload: closes the multipart, verifies
   * the object landed in storage, then — in one transaction — moves the video to
   * `processing`, clears `upload_id`, and enqueues the `video-processing` job
   * (phase-03-videos/TD-03, TD-08).
   */
  async completeUpload(
    id: string,
    userId: string,
    parts: CompletedPartDto[],
  ): Promise<CompleteUploadResult> {
    const video = await this.videoRepository.findOne({
      where: { id },
      relations: ['channel'],
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.channel.user_id !== userId) {
      throw new VideoNotOwnedException();
    }
    if (video.status !== 'draft' || !video.upload_id) {
      throw new VideoUploadAlreadyCompletedException();
    }

    await this.storageService.completeMultipartUpload(
      video.storage_key,
      video.upload_id,
      parts.map((part) => ({
        PartNumber: part.partNumber,
        ETag: part.eTag,
      })),
    );

    try {
      await this.storageService.headObject(video.storage_key);
    } catch {
      throw new VideoUploadVerificationFailedException();
    }

    await this.dataSource.transaction(async (manager) => {
      video.status = 'processing';
      video.upload_id = null;
      await manager.save(video);
      await this.queueService.publishVideoProcessing(video.id, {
        executeSql: async (text, values) => {
          const rows = (await manager.query<unknown[]>(text, values)) ?? [];
          return { rows };
        },
      });
    });

    return { id: video.id, status: video.status };
  }

  /**
   * Public metadata for a video, subject to the visibility rule
   * (phase-03-videos/TD-09).
   */
  async getVideoBySlug(slug: string, userId?: string): Promise<VideoView> {
    const video = await this.getVisibleVideoBySlug(slug, userId);

    const thumbnailUrl = video.thumbnail_key
      ? await this.storageService.presignGetObject(video.thumbnail_key)
      : null;

    return {
      slug: video.slug,
      title: video.title,
      status: video.status,
      durationSeconds: video.duration_seconds,
      thumbnailUrl,
      channel: { nickname: video.channel.nickname },
    };
  }

  /** Short-lived presigned `GetObject` URL for the original — streaming (TD-07). */
  async getStreamRedirectUrl(slug: string, userId?: string): Promise<string> {
    const video = await this.requireStreamableVideo(slug, userId);
    return this.storageService.presignGetObject(video.storage_key);
  }

  /** Same as the stream URL but forces an attachment filename (TD-07). */
  async getDownloadRedirectUrl(slug: string, userId?: string): Promise<string> {
    const video = await this.requireStreamableVideo(slug, userId);
    const ext = extensionOf(video.storage_key);
    const filename = `${sanitizeFilename(video.title ?? video.slug)}.${ext}`;
    return this.storageService.presignGetObject(video.storage_key, {
      disposition: `attachment; filename="${filename}"`,
    });
  }

  /**
   * Reclaims uploads that were started (`draft` + open multipart) and never
   * completed: aborts the orphan multipart and moves the row to a terminal
   * `error` state (abandoned-upload-cleanup/TD-01). Runs from the worker's
   * hourly schedule — a per-row failure is logged and does not stop the sweep
   * (background-task exception, `.claude/rules/nestjs-services.md`).
   */
  async sweepAbandonedUploads(): Promise<{ swept: number }> {
    const cutoff = new Date(Date.now() - ABANDONED_UPLOAD_TTL_HOURS * HOUR_MS);
    const stale = await this.videoRepository.find({
      where: { status: 'draft', created_at: LessThan(cutoff) },
    });

    let swept = 0;
    for (const video of stale) {
      try {
        if (video.upload_id) {
          await this.storageService.abortMultipartUpload(
            video.storage_key,
            video.upload_id,
          );
        }
        video.status = 'error';
        video.error_reason = ABANDONED_UPLOAD_ERROR_REASON;
        video.upload_id = null;
        await this.videoRepository.save(video);
        swept += 1;
      } catch (err) {
        this.logger.error(
          `Failed to reclaim abandoned upload ${video.id}: ${String(err)}`,
        );
      }
    }
    return { swept };
  }

  /**
   * The single read path. Returns the video iff it is `ready` OR the caller owns
   * the channel; otherwise `VIDEO_NOT_FOUND` — never `403` (anti-enumeration,
   * phase-03-videos/TD-09, PLAN §11.5).
   */
  private async getVisibleVideoBySlug(
    slug: string,
    userId?: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { slug },
      relations: ['channel'],
    });
    if (!video) {
      throw new VideoNotFoundException();
    }

    const isOwner = userId != null && video.channel.user_id === userId;
    if (video.status !== 'ready' && !isOwner) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  /** Visible AND the original object exists (a `draft` has no object yet). */
  private async requireStreamableVideo(
    slug: string,
    userId?: string,
  ): Promise<Video> {
    const video = await this.getVisibleVideoBySlug(slug, userId);
    if (video.status === 'draft') {
      throw new VideoNotFoundException();
    }
    return video;
  }

  /** Insert with a `nanoid` slug, retrying on the (vanishingly rare) collision. */
  private async persistDraft(
    id: string,
    channelId: string,
    storageKey: string,
    title?: string,
  ): Promise<Video> {
    for (let attempt = 0; attempt <= MAX_SLUG_RETRIES; attempt++) {
      const video = this.videoRepository.create({
        id,
        channel_id: channelId,
        slug: nanoid(SLUG_LENGTH),
        status: 'draft',
        storage_key: storageKey,
        title: title ?? null,
      });
      try {
        return await this.videoRepository.save(video);
      } catch (err) {
        if (isUniqueViolation(err, 'slug') && attempt < MAX_SLUG_RETRIES) {
          continue;
        }
        throw err;
      }
    }
    throw new Error('Could not generate a unique video slug after max retries');
  }

  private async presignParts(
    storageKey: string,
    uploadId: string,
    fileSize: number,
  ): Promise<UploadPart[]> {
    const count = partCount(fileSize);
    const parts: UploadPart[] = [];
    for (let partNumber = 1; partNumber <= count; partNumber++) {
      parts.push({
        partNumber,
        url: await this.storageService.presignUploadPart(
          storageKey,
          uploadId,
          partNumber,
        ),
      });
    }
    return parts;
  }
}
