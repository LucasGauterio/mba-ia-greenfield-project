import { Module } from '@nestjs/common';
import { QueueService } from './queue.service';

/**
 * pg-boss queue infrastructure. `QueueService` owns the client lifecycle
 * (start + createQueue on boot, graceful stop on shutdown) — see
 * phase-03-videos/TD-01.
 */
@Module({
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
