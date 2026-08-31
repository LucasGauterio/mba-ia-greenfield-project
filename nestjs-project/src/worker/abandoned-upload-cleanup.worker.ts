import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { StorageService } from '../videos/storage.service';
import {
  ABANDONED_UPLOAD_ERROR_REASON,
  ABANDONED_UPLOAD_TTL_HOURS,
} from '../videos/videos.constants';

const MS_PER_HOUR = 60 * 60 * 1000;

@Injectable()
export class AbandonedUploadCleanupWorker {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {}

  async handleJob(): Promise<void> {
    await this.process();
  }

  async process(): Promise<void> {
    const cutoff = new Date(
      Date.now() - ABANDONED_UPLOAD_TTL_HOURS * MS_PER_HOUR,
    );
    const staleDrafts = await this.videoRepository.findBy({
      status: VideoStatus.DRAFT,
      created_at: LessThan(cutoff),
    });

    for (const video of staleDrafts) {
      if (video.upload_id) {
        await this.storageService.abortMultipartUpload(
          video.storage_key,
          video.upload_id,
        );
      }
      video.status = VideoStatus.ERROR;
      video.error_reason = ABANDONED_UPLOAD_ERROR_REASON;
      await this.videoRepository.save(video);
    }
  }
}
