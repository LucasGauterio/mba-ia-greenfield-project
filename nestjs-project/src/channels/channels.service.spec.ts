import { createMock, DeepMocked, PartialFuncReturn } from '@golevelup/ts-jest';
import { DatabaseError } from 'pg';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { ChannelsService } from './channels.service';
import { Channel } from './entities/channel.entity';

function makeManager(
  overrides: PartialFuncReturn<EntityManager> = {},
): DeepMocked<EntityManager> {
  return createMock<EntityManager>({
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    ...overrides,
  });
}

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

function makeUniqueError(): QueryFailedError<DatabaseError> {
  const driverError = new DatabaseError(
    'duplicate key value violates unique constraint',
    0,
    'error',
  );
  driverError.code = '23505';
  driverError.detail = 'Key (nickname)=(abc) already exists.';
  return new QueryFailedError('INSERT', [], driverError);
}

function makeDataSource(manager: EntityManager): DataSource {
  return {
    transaction: jest.fn((cb: (manager: EntityManager) => Promise<Channel>) =>
      cb(manager),
    ),
  } as unknown as DataSource;
}

describe('ChannelsService', () => {
  describe('createChannel', () => {
    it('derives nickname from email prefix and saves when no collision', async () => {
      const channel = makeChannel('test');
      const manager = makeManager({
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockReturnValue(channel),
        save: jest.fn().mockResolvedValue(channel),
      });
      const service = new ChannelsService(makeDataSource(manager));

      const result = await service.createChannel('user-id', 'test@example.com');

      expect(manager.findOne.mock.calls).toContainEqual([
        Channel,
        { where: { nickname: 'test' } },
      ]);
      expect(manager.save.mock.calls.length).toBe(1);
      expect(result.nickname).toBe('test');
    });

    it('retries with suffix when pre-check finds existing nickname', async () => {
      const colliding = makeChannel('john');
      const resolved = makeChannel('john_abc');
      const manager = makeManager({
        findOne: jest
          .fn()
          .mockResolvedValueOnce(colliding)
          .mockResolvedValueOnce(null),
        create: jest.fn().mockReturnValue(resolved),
        save: jest.fn().mockResolvedValue(resolved),
      });
      const service = new ChannelsService(makeDataSource(manager));

      const result = await service.createChannel('user-id', 'john@example.com');

      expect(manager.findOne.mock.calls.length).toBe(2);
      expect(manager.save.mock.calls.length).toBe(1);
      expect(result.nickname).toMatch(/^john_[a-z0-9]{3}$/);
    });

    it('retries with suffix on concurrent unique constraint violation', async () => {
      const resolved = makeChannel('alice_abc');
      const manager = makeManager({
        findOne: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null),
        create: jest.fn().mockReturnValue(resolved),
        save: jest
          .fn()
          .mockRejectedValueOnce(makeUniqueError())
          .mockResolvedValueOnce(resolved),
      });
      const service = new ChannelsService(makeDataSource(manager));

      const result = await service.createChannel(
        'user-id',
        'alice@example.com',
      );

      expect(manager.save.mock.calls.length).toBe(2);
      expect(result.nickname).toMatch(/^alice/);
    });

    it('throws after exhausting max retries', async () => {
      const existing = makeChannel('bob');
      const manager = makeManager({
        findOne: jest.fn().mockResolvedValue(existing),
        create: jest.fn(),
        save: jest.fn(),
      });
      const service = new ChannelsService(makeDataSource(manager));

      await expect(
        service.createChannel('user-id', 'bob@example.com'),
      ).rejects.toThrow(
        'Nickname conflict could not be resolved after max retries',
      );
    });

    it('re-throws non-unique-constraint errors immediately', async () => {
      const unexpectedError = new Error('Connection lost');
      const channel = makeChannel('carol');
      const manager = makeManager({
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockReturnValue(channel),
        save: jest.fn().mockRejectedValue(unexpectedError),
      });
      const service = new ChannelsService(makeDataSource(manager));

      await expect(
        service.createChannel('user-id', 'carol@example.com'),
      ).rejects.toThrow('Connection lost');
      expect(manager.save.mock.calls.length).toBe(1);
    });
  });
});
