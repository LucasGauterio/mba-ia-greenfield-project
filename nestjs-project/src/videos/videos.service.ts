import { randomUUID } from 'crypto';
import { extname } from 'path';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { customAlphabet } from 'nanoid';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { VideoFileTooLargeException } from '../common/exceptions/domain.exception';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { StorageService } from './storage.service';
import {
  MAX_FILE_SIZE_BYTES,
  MAX_SLUG_RETRIES,
  SLUG_ALPHABET,
  SLUG_LENGTH,
  UPLOAD_PART_SIZE_BYTES,
} from './videos.constants';

const PG_UNIQUE_VIOLATION = '23505';
const SLUG_COLUMN = 'slug';

const generateSlug = customAlphabet(SLUG_ALPHABET, SLUG_LENGTH);

function isSlugUniqueViolation(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err as any;
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes(SLUG_COLUMN)
  );
}

export interface InitiateUploadPart {
  partNumber: number;
  uploadUrl: string;
}

export interface InitiateUploadResult {
  id: string;
  slug: string;
  status: VideoStatus;
  uploadId: string;
  parts: InitiateUploadPart[];
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
  ) {}

  async initiateUpload(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<InitiateUploadResult> {
    if (dto.fileSize > MAX_FILE_SIZE_BYTES) {
      throw new VideoFileTooLargeException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error('Channel not found for authenticated user');
    }

    const id = randomUUID();
    const storageKey = `videos/${id}/original${extname(dto.fileName)}`;

    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      dto.contentType,
    );
    const parts = await this.presignUploadParts(
      storageKey,
      uploadId,
      dto.fileSize,
    );

    const video = await this.saveDraftWithUniqueSlug({
      id,
      channelId: channel.id,
      title: dto.title,
      storageKey,
      uploadId,
    });

    return {
      id: video.id,
      slug: video.slug,
      status: video.status,
      uploadId,
      parts,
    };
  }

  private async presignUploadParts(
    storageKey: string,
    uploadId: string,
    fileSize: number,
  ): Promise<InitiateUploadPart[]> {
    const partCount = Math.max(1, Math.ceil(fileSize / UPLOAD_PART_SIZE_BYTES));

    return Promise.all(
      Array.from({ length: partCount }, (_, i) => i + 1).map(
        async (partNumber) => ({
          partNumber,
          uploadUrl: await this.storageService.getUploadPartUrl(
            storageKey,
            uploadId,
            partNumber,
          ),
        }),
      ),
    );
  }

  private async saveDraftWithUniqueSlug(params: {
    id: string;
    channelId: string;
    title?: string;
    storageKey: string;
    uploadId: string;
  }): Promise<Video> {
    for (let attempt = 0; attempt <= MAX_SLUG_RETRIES; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            id: params.id,
            channel_id: params.channelId,
            slug: generateSlug(),
            title: params.title ?? null,
            storage_key: params.storageKey,
            upload_id: params.uploadId,
          }),
        );
      } catch (err) {
        if (!isSlugUniqueViolation(err)) throw err;
      }
    }

    throw new Error('Slug conflict could not be resolved after max retries');
  }
}
