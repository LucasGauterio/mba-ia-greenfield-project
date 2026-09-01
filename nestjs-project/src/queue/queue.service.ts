import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import PgBoss from 'pg-boss';
import queueConfig from '../config/queue.config';
import {
  QUEUE_VIDEO_PROCESSING,
  VIDEO_PROCESSING_JOB_OPTIONS,
} from './queue.constants';

/**
 * Owns the pg-boss client. pg-boss runs on the existing PostgreSQL instance in
 * a dedicated `pgboss` schema (phase-03-videos/TD-01); this service starts it
 * with the app, declares the queues, and stops it gracefully on shutdown. The
 * separate `video-worker` container consumes the queues through `client`.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly boss: PgBoss;

  constructor(@Inject(queueConfig.KEY) config: ConfigType<typeof queueConfig>) {
    this.boss = new PgBoss({
      connectionString: config.connectionString,
      schema: config.schema,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.boss.start();
    await this.boss.createQueue(QUEUE_VIDEO_PROCESSING);
  }

  async onModuleDestroy(): Promise<void> {
    await this.boss.stop({ graceful: true });
  }

  /** The underlying pg-boss client — the worker entrypoint consumes queues through it. */
  get client(): PgBoss {
    return this.boss;
  }

  /**
   * Enqueues a `video-processing` job. When `db` is supplied the job INSERT
   * runs on that connection, making the enqueue atomic with the caller's
   * transaction (phase-03-videos/TD-01, TD-03).
   */
  async publishVideoProcessing(videoId: string, db?: PgBoss.Db): Promise<void> {
    await this.boss.send(
      QUEUE_VIDEO_PROCESSING,
      { videoId },
      { ...VIDEO_PROCESSING_JOB_OPTIONS, ...(db ? { db } : {}) },
    );
  }
}
