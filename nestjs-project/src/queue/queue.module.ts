import { Global, Inject, Module } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { PgBoss } from 'pg-boss';
import queueConfig from '../config/queue.config';
import {
  CLEANUP_ABANDONED_UPLOADS_CRON,
  PG_BOSS,
  QUEUE_NAMES,
} from './queue.constants';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: PG_BOSS,
      inject: [queueConfig.KEY],
      useFactory: async (
        config: ConfigType<typeof queueConfig>,
      ): Promise<PgBoss> => {
        const boss = new PgBoss({ connectionString: config.connectionString });
        await boss.start();

        const existingQueue = await boss.getQueue(QUEUE_NAMES.VIDEO_PROCESSING);
        if (!existingQueue) {
          await boss.createQueue(QUEUE_NAMES.VIDEO_PROCESSING, {
            retryLimit: 3,
            retryDelay: 5,
            retryBackoff: true,
          });
        }

        const existingCleanupQueue = await boss.getQueue(
          QUEUE_NAMES.CLEANUP_ABANDONED_UPLOADS,
        );
        if (!existingCleanupQueue) {
          await boss.createQueue(QUEUE_NAMES.CLEANUP_ABANDONED_UPLOADS);
        }
        await boss.schedule(
          QUEUE_NAMES.CLEANUP_ABANDONED_UPLOADS,
          CLEANUP_ABANDONED_UPLOADS_CRON,
        );

        return boss;
      },
    },
  ],
  exports: [PG_BOSS],
})
export class QueueModule implements OnModuleDestroy {
  constructor(@Inject(PG_BOSS) private readonly boss: PgBoss) {}

  async onModuleDestroy(): Promise<void> {
    await this.boss.stop();
  }
}
