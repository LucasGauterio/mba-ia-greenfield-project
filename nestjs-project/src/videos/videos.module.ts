import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { ChannelsModule } from '../channels/channels.module';
import { QueueModule } from '../queue/queue.module';
import { Video } from './entities/video.entity';
import { StorageService } from './storage.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    ChannelsModule,
    QueueModule,
    AuthModule,
  ],
  controllers: [VideosController],
  providers: [VideosService, StorageService],
  exports: [VideosService],
})
export class VideosModule {}
