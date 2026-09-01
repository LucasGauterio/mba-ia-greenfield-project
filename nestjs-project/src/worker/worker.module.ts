import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import databaseConfig from '../config/database.config';
import { envValidationSchema } from '../config/env.validation';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { QueueModule } from '../queue/queue.module';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { StorageService } from '../videos/storage.service';
import { VideosService } from '../videos/videos.service';
import { AbandonedUploadCleanupWorker } from './abandoned-upload-cleanup.worker';
import { VideoProcessingWorker } from './video-processing.worker';

/**
 * Standalone Nest context for the `video-worker` container. It shares the
 * database and pg-boss instance with the API but exposes no HTTP surface — its
 * entrypoint (`main.ts`) registers a pg-boss `work()` handler (TD-05).
 *
 * `forFeature([Video, Channel, User])` registers the full `Video -> Channel ->
 * User` relation chain so TypeORM can build the metadata even though the worker
 * only queries `Video` (PLAN §11.2).
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, queueConfig, storageConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature([Video, Channel, User]),
    QueueModule,
  ],
  providers: [
    StorageService,
    VideosService,
    VideoProcessingWorker,
    AbandonedUploadCleanupWorker,
  ],
})
export class WorkerModule {}
