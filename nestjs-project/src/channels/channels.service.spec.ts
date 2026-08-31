import { createMock } from '@golevelup/ts-jest';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { ChannelsService } from './channels.service';
import { Channel } from './entities/channel.entity';

function makeChannel(nickname: string): Channel {
  const c = new Channel();
  c.id = 'uuid';
  c.nickname = nickname;
  c.name = nickname;
  c.user_id = 'user-id';
  c.description = null;
  c.created_at = new Date();
  c.updated_at = new Date();
  return c;
}

function makeUniqueError(): QueryFailedError {
  return Object.assign(
    new QueryFailedError('INSERT', [], new Error('duplicate key')),
    { code: '23505', detail: 'Key (nickname)=(abc) already exists.' },
  );
}

function makeDataSource(manager: EntityManager): DataSource {
  const dataSource = createMock<DataSource>();
  dataSource.transaction.mockImplementation((runInTransaction: unknown) =>
    (runInTransaction as (em: EntityManager) => Promise<unknown>)(manager),
  );
  return dataSource;
}

describe('ChannelsService', () => {
  describe('createChannel', () => {
    it('derives nickname from email prefix and saves when no collision', async () => {
      const channel = makeChannel('test');
      const manager = createMock<EntityManager>();
      manager.findOne.mockResolvedValue(null);
      manager.save.mockResolvedValue(channel);
      const service = new ChannelsService(makeDataSource(manager));

      const result = await service.createChannel('user-id', 'test@example.com');

      expect(manager.findOne).toHaveBeenCalledWith(Channel, {
        where: { nickname: 'test' },
      });
      expect(manager.save).toHaveBeenCalledTimes(1);
      expect(result.nickname).toBe('test');
    });

    it('retries with suffix when pre-check finds existing nickname', async () => {
      const colliding = makeChannel('john');
      const resolved = makeChannel('john_abc');
      const manager = createMock<EntityManager>();
      manager.findOne
        .mockResolvedValueOnce(colliding)
        .mockResolvedValueOnce(null);
      manager.save.mockResolvedValue(resolved);
      const service = new ChannelsService(makeDataSource(manager));

      const result = await service.createChannel('user-id', 'john@example.com');

      expect(manager.findOne).toHaveBeenCalledTimes(2);
      expect(manager.save).toHaveBeenCalledTimes(1);
      expect(result.nickname).toMatch(/^john_[a-z0-9]{3}$/);
    });

    it('retries with suffix on concurrent unique constraint violation', async () => {
      const resolved = makeChannel('alice_abc');
      const manager = createMock<EntityManager>();
      manager.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      manager.save
        .mockRejectedValueOnce(makeUniqueError())
        .mockResolvedValueOnce(resolved);
      const service = new ChannelsService(makeDataSource(manager));

      const result = await service.createChannel(
        'user-id',
        'alice@example.com',
      );

      expect(manager.save).toHaveBeenCalledTimes(2);
      expect(result.nickname).toMatch(/^alice/);
    });

    it('throws after exhausting max retries', async () => {
      const existing = makeChannel('bob');
      const manager = createMock<EntityManager>();
      manager.findOne.mockResolvedValue(existing);
      const service = new ChannelsService(makeDataSource(manager));

      await expect(
        service.createChannel('user-id', 'bob@example.com'),
      ).rejects.toThrow(
        'Nickname conflict could not be resolved after max retries',
      );
    });

    it('re-throws non-unique-constraint errors immediately', async () => {
      const unexpectedError = new Error('Connection lost');
      const manager = createMock<EntityManager>();
      manager.findOne.mockResolvedValue(null);
      manager.save.mockRejectedValue(unexpectedError);
      const service = new ChannelsService(makeDataSource(manager));

      await expect(
        service.createChannel('user-id', 'carol@example.com'),
      ).rejects.toThrow('Connection lost');
      expect(manager.save).toHaveBeenCalledTimes(1);
    });
  });
});
