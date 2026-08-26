import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

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
        email: `video_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `video_chan_${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('should enforce the channel_id not-null constraint', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          slug: 'novchanid1',
          storage_key: 'videos/1/original.mp4',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should enforce the channel_id foreign key constraint', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: randomUUID(),
          slug: 'nofkchanid',
          storage_key: 'videos/2/original.mp4',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should enforce the unique slug constraint', async () => {
    const channel = await createChannel();

    await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        slug: 'dupeslug01',
        storage_key: 'videos/3/original.mp4',
      }),
    );

    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: channel.id,
          slug: 'dupeslug01',
          storage_key: 'videos/4/original.mp4',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should default status to draft', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        slug: 'defstatus1',
        storage_key: 'videos/5/original.mp4',
      }),
    );

    expect(video.status).toBe(VideoStatus.DRAFT);
  });

  it('should load the related channel via the ManyToOne relation', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        slug: 'relchanid1',
        storage_key: 'videos/6/original.mp4',
      }),
    );

    const found = await videoRepository.findOne({
      where: { slug: 'relchanid1' },
      relations: ['channel'],
    });

    expect(found?.channel.id).toBe(channel.id);
  });
});
