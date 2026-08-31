import { NestFactory } from '@nestjs/core';
import type { JobWithMetadata, PgBoss } from 'pg-boss';
import { PG_BOSS, QUEUE_NAMES } from '../queue/queue.constants';
import { AbandonedUploadCleanupWorker } from './abandoned-upload-cleanup.worker';
import type { VideoProcessingJobData } from './video-processing.worker';
import { VideoProcessingWorker } from './video-processing.worker';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);

  const boss = app.get<PgBoss>(PG_BOSS);
  const worker = app.get(VideoProcessingWorker);
  const cleanupWorker = app.get(AbandonedUploadCleanupWorker);

  await boss.work(
    QUEUE_NAMES.VIDEO_PROCESSING,
    { includeMetadata: true },
    async ([job]: JobWithMetadata<VideoProcessingJobData>[]) =>
      worker.handleJob(job),
  );

  await boss.work(QUEUE_NAMES.CLEANUP_ABANDONED_UPLOADS, async () =>
    cleanupWorker.handleJob(),
  );
}

void bootstrap();
