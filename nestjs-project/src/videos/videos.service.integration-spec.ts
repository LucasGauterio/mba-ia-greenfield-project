import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { StorageService } from './storage.service';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelsService: ChannelsService;
  let videosService: VideosService;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
      ],
      providers: [VideosService, StorageService, ChannelsService],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelsService = moduleRef.get(ChannelsService);
    videosService = moduleRef.get(VideosService);
  }, 30000);

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_svc_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelsService.createChannel(user.id, user.email);
  }

  it('persists a draft video with the correct fields', async () => {
    const channel = await createChannel();

    const result = await videosService.initiateUpload(channel.user_id, {
      fileName: 'clip.mp4',
      fileSize: 12 * 1024 ** 2,
      contentType: 'video/mp4',
      title: 'My clip',
    });

    expect(result.id).toBeDefined();
    expect(result.slug).toHaveLength(10);
    expect(result.status).toBe(VideoStatus.DRAFT);
    expect(result.uploadId).toBeDefined();
    expect(result.parts.length).toBeGreaterThan(0);
    expect(result.parts[0].uploadUrl).toContain('http');

    const persisted = await dataSource
      .getRepository(Video)
      .findOneBy({ id: result.id });
    expect(persisted).not.toBeNull();
    expect(persisted!.channel_id).toBe(channel.id);
    expect(persisted!.title).toBe('My clip');
    expect(persisted!.status).toBe(VideoStatus.DRAFT);
    expect(persisted!.storage_key).toBe(`videos/${result.id}/original.mp4`);
    expect(persisted!.upload_id).toBe(result.uploadId);
  }, 30000);

  it('produces no colliding slugs under concurrent initiations', async () => {
    const channel = await createChannel();

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        videosService.initiateUpload(channel.user_id, {
          fileName: `clip-${i}.mp4`,
          fileSize: 1024,
          contentType: 'video/mp4',
        }),
      ),
    );

    const slugs = results.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  }, 30000);
});
