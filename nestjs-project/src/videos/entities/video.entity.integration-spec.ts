import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { User } from '../../users/entities/user.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    // synchronize: false — the schema comes from the CreateVideos migration
    // (per .claude/rules/typeorm-migrations.md: never synchronize).
    dataSource = createTestDataSource(ALL_ENTITIES, { synchronize: false });
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
        email: `vid_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `vidchan_${counter}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(
    channelId: string,
    overrides: Partial<Video> = {},
  ): Partial<Video> {
    return {
      channel_id: channelId,
      slug: `slug${++counter}`.slice(0, 10),
      storage_key: `videos/${channelId}/original.mp4`,
      ...overrides,
    };
  }

  it('defaults status to draft and stamps created_at / updated_at', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create(buildVideo(channel.id)),
    );

    expect(video.id).toBeDefined();
    expect(video.status).toBe('draft');
    expect(video.created_at).toBeInstanceOf(Date);
    expect(video.updated_at).toBeInstanceOf(Date);
    expect(video.title).toBeNull();
    expect(video.thumbnail_key).toBeNull();
    expect(video.upload_id).toBeNull();
    expect(video.duration_seconds).toBeNull();
    expect(video.metadata).toBeNull();
  });

  it('enforces a unique slug', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create(buildVideo(channel.id, { slug: 'dupeslug' })),
    );

    await expect(
      videoRepository.save(
        videoRepository.create(buildVideo(channel.id, { slug: 'dupeslug' })),
      ),
    ).rejects.toThrow(QueryFailedError);
  });

  it('rejects a video without a channel_id (not-null)', async () => {
    const video = videoRepository.create({
      slug: 'nochannel1',
      storage_key: 'videos/x/original.mp4',
    });

    await expect(videoRepository.save(video)).rejects.toThrow(QueryFailedError);
  });

  it('rejects a channel_id that does not reference an existing channel (FK)', async () => {
    const video = videoRepository.create(
      buildVideo('00000000-0000-4000-8000-000000000000'),
    );

    await expect(videoRepository.save(video)).rejects.toThrow(QueryFailedError);
  });

  it('accepts only the four enum values for status', async () => {
    const channel = await createChannel();

    for (const status of ['draft', 'processing', 'ready', 'error'] as const) {
      const video = await videoRepository.save(
        videoRepository.create(buildVideo(channel.id, { status })),
      );
      expect(video.status).toBe(status);
    }

    await expect(
      dataSource.query(
        `INSERT INTO "videos" ("channel_id", "slug", "storage_key", "status")
         VALUES ($1, 'badenum', 'videos/x/original.mp4', 'archived')`,
        [channel.id],
      ),
    ).rejects.toThrow(QueryFailedError);
  });

  it('persists metadata as jsonb and loads the related channel via ManyToOne', async () => {
    const channel = await createChannel();
    const metadata = {
      format: { duration: '12.5' },
      streams: [{ codec: 'h264' }],
    };

    await videoRepository.save(
      videoRepository.create(
        buildVideo(channel.id, {
          slug: 'withmeta',
          metadata,
          duration_seconds: 12,
        }),
      ),
    );

    const found = await videoRepository.findOne({
      where: { slug: 'withmeta' },
      relations: ['channel'],
    });

    expect(found?.metadata).toEqual(metadata);
    expect(found?.duration_seconds).toBe(12);
    expect(found?.channel.id).toBe(channel.id);
  });
});
