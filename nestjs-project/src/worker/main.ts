import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  QUEUE_ABANDONED_UPLOAD_SWEEP,
  QUEUE_VIDEO_PROCESSING,
  type VideoProcessingPayload,
} from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { ABANDONED_UPLOAD_SWEEP_CRON } from '../videos/videos.constants';
import { AbandonedUploadCleanupWorker } from './abandoned-upload-cleanup.worker';
import { VideoProcessingWorker } from './video-processing.worker';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('VideoWorker');
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();

  const boss = app.get(QueueService).client;
  const processingWorker = app.get(VideoProcessingWorker);
  const cleanupWorker = app.get(AbandonedUploadCleanupWorker);

  // pg-boss hands the handler an array even with batchSize: 1 (v10 — see
  // library-refs.md). includeMetadata populates retryCount / retryLimit.
  await boss.work<VideoProcessingPayload>(
    QUEUE_VIDEO_PROCESSING,
    { batchSize: 1, includeMetadata: true },
    async ([job]) => {
      await processingWorker.handleJob(job);
    },
  );

  // Hourly sweep of abandoned uploads (abandoned-upload-cleanup/TD-01).
  await boss.createQueue(QUEUE_ABANDONED_UPLOAD_SWEEP);
  await boss.schedule(
    QUEUE_ABANDONED_UPLOAD_SWEEP,
    ABANDONED_UPLOAD_SWEEP_CRON,
  );
  await boss.work(QUEUE_ABANDONED_UPLOAD_SWEEP, async () => {
    await cleanupWorker.handleJob();
  });

  logger.log(
    `Consuming queues "${QUEUE_VIDEO_PROCESSING}", "${QUEUE_ABANDONED_UPLOAD_SWEEP}" (cron ${ABANDONED_UPLOAD_SWEEP_CRON})`,
  );
}

void bootstrap();
