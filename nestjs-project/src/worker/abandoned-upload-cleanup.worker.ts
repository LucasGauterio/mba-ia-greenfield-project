import { Injectable, Logger } from '@nestjs/common';
import { VideosService } from '../videos/videos.service';

/**
 * Consumes the scheduled `abandoned-upload-sweep` job and delegates to
 * `VideosService.sweepAbandonedUploads` (abandoned-upload-cleanup/TD-01).
 */
@Injectable()
export class AbandonedUploadCleanupWorker {
  private readonly logger = new Logger(AbandonedUploadCleanupWorker.name);

  constructor(private readonly videosService: VideosService) {}

  async handleJob(): Promise<void> {
    const { swept } = await this.videosService.sweepAbandonedUploads();
    if (swept > 0) {
      this.logger.log(`Reclaimed ${swept} abandoned upload(s)`);
    }
  }
}
