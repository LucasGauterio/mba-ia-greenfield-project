import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { ChannelsModule } from '../channels/channels.module';
import { QueueModule } from '../queue/queue.module';
import { Video } from './entities/video.entity';
import { StorageService } from './storage.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    // ChannelsModule re-exports the Channel repository — VideosService reads it
    // to resolve the caller's channel. AuthModule re-exports JwtModule, needed
    // by SI-03.8's OptionalJwtAuthGuard.
    ChannelsModule,
    AuthModule,
    QueueModule,
  ],
  controllers: [VideosController],
  providers: [StorageService, VideosService, OptionalJwtAuthGuard],
  exports: [StorageService, VideosService],
})
export class VideosModule {}
