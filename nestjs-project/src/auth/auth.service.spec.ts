import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import type { ConfigType } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createMock, DeepMocked } from '@golevelup/ts-jest';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import {
  EmailAlreadyExistsException,
  EmailNotConfirmedException,
  InvalidCredentialsException,
  InvalidTokenException,
  TokenExpiredException,
  TokenReuseDetectedException,
} from '../common/exceptions/domain.exception';
import authConfig from '../config/auth.config';
import { MailService } from '../mail/mail.service';
import { User } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { RefreshToken } from './entities/refresh-token.entity';
import {
  VerificationToken,
  VerificationTokenType,
} from './entities/verification-token.entity';

const authCfg: ConfigType<typeof authConfig> = {
  jwtSecret: 'test-secret',
  jwtRefreshSecret: 'test-refresh-secret',
  jwtAccessExpiration: '15m',
  jwtRefreshExpiration: '7d',
  confirmationTokenExpirationHours: 1,
  passwordResetTokenExpirationHours: 1,
};

const jwtService = new JwtService({
  secret: 'test-secret',
  signOptions: { expiresIn: '15m' },
});

function makeUser(overrides: Partial<User> = {}): User {
  const u = new User();
  u.id = 'u1';
  u.email = 'user@example.com';
  u.password = 'hashed-password';
  u.is_confirmed = true;
  u.created_at = new Date();
  u.updated_at = new Date();
  return Object.assign(u, overrides);
}

function makeChannelNamed(name: string): Channel {
  const c = new Channel();
  c.name = name;
  c.nickname = name;
  return c;
}

function makeVerificationToken(
  overrides: Partial<VerificationToken> = {},
): VerificationToken {
  const t = new VerificationToken();
  t.id = 'vt1';
  t.token_hash = 'token-hash';
  t.type = VerificationTokenType.EMAIL_CONFIRMATION;
  t.user_id = 'u1';
  t.expires_at = new Date(Date.now() + 60_000);
  t.used_at = null;
  t.created_at = new Date();
  return Object.assign(t, overrides);
}

function makeRefreshToken(overrides: Partial<RefreshToken> = {}): RefreshToken {
  const t = new RefreshToken();
  t.id = 'rt1';
  t.token_hash = 'token-hash';
  t.family = 'family-uuid';
  t.user_id = 'u1';
  t.expires_at = new Date(Date.now() + 60_000);
  t.revoked_at = null;
  t.created_at = new Date();
  return Object.assign(t, overrides);
}

interface QueryBuilderMock {
  update: jest.Mock;
  set: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  execute: jest.Mock;
}

function makeQueryBuilder(): QueryBuilderMock {
  const qb: QueryBuilderMock = {
    update: jest.fn(),
    set: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    execute: jest.fn().mockResolvedValue(undefined),
  };
  qb.update.mockReturnValue(qb);
  qb.set.mockReturnValue(qb);
  qb.where.mockReturnValue(qb);
  qb.andWhere.mockReturnValue(qb);
  return qb;
}

function asQueryBuilder<T extends object>(
  qb: QueryBuilderMock,
): SelectQueryBuilder<T> {
  return qb as unknown as SelectQueryBuilder<T>;
}

interface AuthTestContext {
  authService: AuthService;
  usersService: DeepMocked<UsersService>;
  mailService: DeepMocked<MailService>;
  verificationTokenRepository: DeepMocked<Repository<VerificationToken>>;
  refreshTokenRepository: DeepMocked<Repository<RefreshToken>>;
}

function setup(): AuthTestContext {
  const usersService = createMock<UsersService>();
  const mailService = createMock<MailService>();
  const verificationTokenRepository =
    createMock<Repository<VerificationToken>>();
  const refreshTokenRepository = createMock<Repository<RefreshToken>>();

  const authService = new AuthService(
    usersService,
    mailService,
    jwtService,
    verificationTokenRepository,
    refreshTokenRepository,
    authCfg,
  );

  return {
    authService,
    usersService,
    mailService,
    verificationTokenRepository,
    refreshTokenRepository,
  };
}

describe('AuthService — register', () => {
  let ctx: AuthTestContext;

  beforeEach(() => {
    ctx = setup();
  });

  it('throws EmailAlreadyExistsException when email is already registered', async () => {
    ctx.usersService.findByEmail.mockResolvedValue(
      makeUser({ email: 'test@example.com' }),
    );

    await expect(
      ctx.authService.register({
        email: 'test@example.com',
        password: 'password123',
      }),
    ).rejects.toThrow(EmailAlreadyExistsException);
  });

  it('hashes the password before creating the user', async () => {
    ctx.usersService.findByEmail.mockResolvedValue(null);
    ctx.usersService.createUserWithChannel.mockResolvedValue(
      makeUser({ email: 'new@example.com', channel: makeChannelNamed('new') }),
    );

    await ctx.authService.register({
      email: 'new@example.com',
      password: 'plaintext',
    });

    const [, hashedPassword] =
      ctx.usersService.createUserWithChannel.mock.calls[0];
    expect(hashedPassword).not.toBe('plaintext');
    expect(hashedPassword).toMatch(/^\$argon2/);
  });

  it('calls createUserWithChannel with the correct email', async () => {
    ctx.usersService.findByEmail.mockResolvedValue(null);
    ctx.usersService.createUserWithChannel.mockResolvedValue(
      makeUser({ email: 'new@example.com', channel: makeChannelNamed('new') }),
    );

    await ctx.authService.register({
      email: 'new@example.com',
      password: 'password123',
    });

    expect(ctx.usersService.createUserWithChannel).toHaveBeenCalledWith(
      'new@example.com',
      expect.any(String),
    );
  });

  it('stores a verification token with EMAIL_CONFIRMATION type', async () => {
    ctx.usersService.findByEmail.mockResolvedValue(null);
    ctx.usersService.createUserWithChannel.mockResolvedValue(
      makeUser({ email: 'new@example.com', channel: makeChannelNamed('new') }),
    );
    const createdToken = makeVerificationToken({
      type: VerificationTokenType.EMAIL_CONFIRMATION,
    });
    ctx.verificationTokenRepository.create.mockReturnValue(createdToken);

    await ctx.authService.register({
      email: 'new@example.com',
      password: 'password123',
    });

    expect(ctx.verificationTokenRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: VerificationTokenType.EMAIL_CONFIRMATION,
        user_id: 'u1',
      }),
    );
    expect(ctx.verificationTokenRepository.save).toHaveBeenCalledWith(
      createdToken,
    );
  });

  it('sends a confirmation email with the raw token', async () => {
    ctx.usersService.findByEmail.mockResolvedValue(null);
    ctx.usersService.createUserWithChannel.mockResolvedValue(
      makeUser({
        email: 'new@example.com',
        channel: makeChannelNamed('mynick'),
      }),
    );

    await ctx.authService.register({
      email: 'new@example.com',
      password: 'password123',
    });

    expect(ctx.mailService.sendConfirmationEmail).toHaveBeenCalledWith(
      'new@example.com',
      'mynick',
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
  });

  it('returns the user id and email', async () => {
    ctx.usersService.findByEmail.mockResolvedValue(null);
    ctx.usersService.createUserWithChannel.mockResolvedValue(
      makeUser({ email: 'new@example.com', channel: makeChannelNamed('new') }),
    );

    const result = await ctx.authService.register({
      email: 'new@example.com',
      password: 'password123',
    });

    expect(result).toEqual({ id: 'u1', email: 'new@example.com' });
  });
});

describe('AuthService — confirm', () => {
  let ctx: AuthTestContext;

  beforeEach(() => {
    ctx = setup();
  });

  it('marks user as confirmed and token as used for a valid token', async () => {
    const rawToken = 'a'.repeat(64);
    const tokenHash = crypto
      .createHash('sha256')
      .update(rawToken)
      .digest('hex');
    const user = makeUser({ is_confirmed: false });
    const record = makeVerificationToken({
      token_hash: tokenHash,
      type: VerificationTokenType.EMAIL_CONFIRMATION,
      used_at: null,
      expires_at: new Date(Date.now() + 60_000),
      user,
    });

    ctx.verificationTokenRepository.findOne.mockResolvedValue(record);

    await ctx.authService.confirm(rawToken);

    expect(record.used_at).toBeInstanceOf(Date);
    expect(user.is_confirmed).toBe(true);
    expect(ctx.verificationTokenRepository.save).toHaveBeenCalledWith(record);
    expect(ctx.usersService.save).toHaveBeenCalledWith(user);
  });

  it('throws InvalidTokenException when token is not found', async () => {
    ctx.verificationTokenRepository.findOne.mockResolvedValue(null);

    await expect(ctx.authService.confirm('nonexistent-token')).rejects.toThrow(
      InvalidTokenException,
    );
  });

  it('throws TokenExpiredException when token is expired', async () => {
    const rawToken = 'b'.repeat(64);
    const record = makeVerificationToken({
      token_hash: crypto.createHash('sha256').update(rawToken).digest('hex'),
      type: VerificationTokenType.EMAIL_CONFIRMATION,
      used_at: null,
      expires_at: new Date(Date.now() - 1000),
      user: makeUser({ is_confirmed: false }),
    });

    ctx.verificationTokenRepository.findOne.mockResolvedValue(record);

    await expect(ctx.authService.confirm(rawToken)).rejects.toThrow(
      TokenExpiredException,
    );
  });
});

describe('AuthService — resendConfirmation', () => {
  let ctx: AuthTestContext;

  beforeEach(() => {
    ctx = setup();
  });

  it('returns silently when email is not found', async () => {
    ctx.usersService.findByEmailWithChannel.mockResolvedValue(null);

    await expect(
      ctx.authService.resendConfirmation('unknown@example.com'),
    ).resolves.toBeUndefined();
    expect(ctx.mailService.sendConfirmationEmail).not.toHaveBeenCalled();
  });

  it('returns silently when user is already confirmed', async () => {
    ctx.usersService.findByEmailWithChannel.mockResolvedValue(
      makeUser({ is_confirmed: true, channel: makeChannelNamed('nick') }),
    );

    await expect(
      ctx.authService.resendConfirmation('confirmed@example.com'),
    ).resolves.toBeUndefined();
    expect(ctx.mailService.sendConfirmationEmail).not.toHaveBeenCalled();
  });

  it('invalidates old tokens and sends a new confirmation email', async () => {
    const user = makeUser({
      email: 'user@example.com',
      is_confirmed: false,
      channel: makeChannelNamed('nick'),
    });
    ctx.usersService.findByEmailWithChannel.mockResolvedValue(user);

    const qb = makeQueryBuilder();
    ctx.verificationTokenRepository.createQueryBuilder.mockReturnValue(
      asQueryBuilder<VerificationToken>(qb),
    );

    await ctx.authService.resendConfirmation('user@example.com');

    expect(qb.execute).toHaveBeenCalled();
    expect(ctx.verificationTokenRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: VerificationTokenType.EMAIL_CONFIRMATION,
        user_id: 'u1',
      }),
    );
    expect(ctx.mailService.sendConfirmationEmail).toHaveBeenCalledWith(
      'user@example.com',
      'nick',
      expect.any(String),
    );
  });
});

describe('AuthService — login', () => {
  let ctx: AuthTestContext;
  let hashedTestPassword: string;

  beforeAll(async () => {
    hashedTestPassword = await argon2.hash('correctpassword');
  });

  beforeEach(() => {
    ctx = setup();
  });

  it('throws InvalidCredentialsException when email is not found', async () => {
    ctx.usersService.findByEmail.mockResolvedValue(null);

    await expect(
      ctx.authService.login({
        email: 'nobody@example.com',
        password: 'password123',
      }),
    ).rejects.toThrow(InvalidCredentialsException);
  });

  it('throws InvalidCredentialsException when password is wrong', async () => {
    ctx.usersService.findByEmail.mockResolvedValue(
      makeUser({ password: hashedTestPassword, is_confirmed: true }),
    );

    await expect(
      ctx.authService.login({
        email: 'user@example.com',
        password: 'wrongpassword',
      }),
    ).rejects.toThrow(InvalidCredentialsException);
  });

  it('throws EmailNotConfirmedException when user is not confirmed', async () => {
    ctx.usersService.findByEmail.mockResolvedValue(
      makeUser({ password: hashedTestPassword, is_confirmed: false }),
    );

    await expect(
      ctx.authService.login({
        email: 'user@example.com',
        password: 'correctpassword',
      }),
    ).rejects.toThrow(EmailNotConfirmedException);
  });

  it('returns access_token and refresh_token on valid credentials', async () => {
    ctx.usersService.findByEmail.mockResolvedValue(
      makeUser({ password: hashedTestPassword, is_confirmed: true }),
    );

    const result = await ctx.authService.login({
      email: 'user@example.com',
      password: 'correctpassword',
    });

    expect(result.access_token).toBeDefined();
    expect(result.refresh_token).toBeDefined();
    expect(typeof result.access_token).toBe('string');
    expect(typeof result.refresh_token).toBe('string');
    expect(ctx.refreshTokenRepository.save).toHaveBeenCalled();
  });
});

describe('AuthService — refresh', () => {
  let ctx: AuthTestContext;

  const rawToken = 'a'.repeat(64);
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  beforeEach(() => {
    ctx = setup();
  });

  it('throws InvalidTokenException when token is not found', async () => {
    ctx.refreshTokenRepository.findOne.mockResolvedValue(null);

    await expect(ctx.authService.refresh(rawToken)).rejects.toThrow(
      InvalidTokenException,
    );
  });

  it('throws TokenExpiredException when token is expired', async () => {
    const record = makeRefreshToken({
      token_hash: tokenHash,
      user: makeUser(),
      expires_at: new Date(Date.now() - 1000),
      revoked_at: null,
    });
    ctx.refreshTokenRepository.findOne.mockResolvedValue(record);

    await expect(ctx.authService.refresh(rawToken)).rejects.toThrow(
      TokenExpiredException,
    );
  });

  it('rotates token: revokes old, persists new, returns both tokens', async () => {
    const record = makeRefreshToken({
      token_hash: tokenHash,
      user: makeUser(),
      expires_at: new Date(Date.now() + 60_000),
      revoked_at: null,
    });
    ctx.refreshTokenRepository.findOne.mockResolvedValue(record);

    const result = await ctx.authService.refresh(rawToken);

    expect(record.revoked_at).toBeInstanceOf(Date);
    expect(ctx.refreshTokenRepository.save).toHaveBeenCalledWith(record);
    expect(ctx.refreshTokenRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ family: 'family-uuid', user_id: 'u1' }),
    );
    expect(result.access_token).toBeDefined();
    expect(result.refresh_token).toBeDefined();
    expect(result.refresh_token).not.toBe(rawToken);
  });

  it('returns new access token without revoking family when reuse is within grace period', async () => {
    const record = makeRefreshToken({
      token_hash: tokenHash,
      user: makeUser(),
      expires_at: new Date(Date.now() + 60_000),
      revoked_at: new Date(Date.now() - 5_000),
    });
    ctx.refreshTokenRepository.findOne.mockResolvedValue(record);

    const result = await ctx.authService.refresh(rawToken);

    expect(result.access_token).toBeDefined();
    expect(result.refresh_token).toBe(rawToken);
    expect(
      ctx.refreshTokenRepository.createQueryBuilder,
    ).not.toHaveBeenCalled();
  });

  it('revokes entire family and throws TokenReuseDetectedException beyond grace period', async () => {
    const record = makeRefreshToken({
      token_hash: tokenHash,
      user: makeUser(),
      expires_at: new Date(Date.now() + 60_000),
      revoked_at: new Date(Date.now() - 15_000),
    });
    ctx.refreshTokenRepository.findOne.mockResolvedValue(record);

    const qb = makeQueryBuilder();
    ctx.refreshTokenRepository.createQueryBuilder.mockReturnValue(
      asQueryBuilder<RefreshToken>(qb),
    );

    await expect(ctx.authService.refresh(rawToken)).rejects.toThrow(
      TokenReuseDetectedException,
    );

    expect(qb.execute).toHaveBeenCalled();
    expect(qb.where).toHaveBeenCalledWith('family = :family', {
      family: 'family-uuid',
    });
  });
});

describe('AuthService — logout', () => {
  let ctx: AuthTestContext;

  beforeEach(() => {
    ctx = setup();
  });

  it('revokes all active refresh tokens for the user', async () => {
    const qb = makeQueryBuilder();
    ctx.refreshTokenRepository.createQueryBuilder.mockReturnValue(
      asQueryBuilder<RefreshToken>(qb),
    );

    await ctx.authService.logout('user-id-123');

    expect(qb.set).toHaveBeenCalledWith({
      revoked_at: expect.any(Date) as unknown,
    });
    expect(qb.where).toHaveBeenCalledWith('user_id = :userId', {
      userId: 'user-id-123',
    });
    expect(qb.andWhere).toHaveBeenCalledWith('revoked_at IS NULL');
    expect(qb.execute).toHaveBeenCalled();
  });
});

describe('AuthService — forgotPassword', () => {
  let ctx: AuthTestContext;

  beforeEach(() => {
    ctx = setup();
  });

  it('returns silently when email is not registered', async () => {
    ctx.usersService.findByEmailWithChannel.mockResolvedValue(null);

    await expect(
      ctx.authService.forgotPassword('unknown@example.com'),
    ).resolves.toBeUndefined();
    expect(ctx.mailService.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('invalidates previous reset tokens and sends a reset email', async () => {
    const user = makeUser({
      email: 'user@example.com',
      channel: makeChannelNamed('nick'),
    });
    ctx.usersService.findByEmailWithChannel.mockResolvedValue(user);

    const qb = makeQueryBuilder();
    ctx.verificationTokenRepository.createQueryBuilder.mockReturnValue(
      asQueryBuilder<VerificationToken>(qb),
    );

    await ctx.authService.forgotPassword('user@example.com');

    expect(qb.execute).toHaveBeenCalled();
    expect(qb.andWhere).toHaveBeenCalledWith('type = :type', {
      type: VerificationTokenType.PASSWORD_RESET,
    });
    expect(ctx.verificationTokenRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: VerificationTokenType.PASSWORD_RESET,
        user_id: 'u1',
      }),
    );
    expect(ctx.mailService.sendPasswordResetEmail).toHaveBeenCalledWith(
      'user@example.com',
      'nick',
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
  });
});

describe('AuthService — resetPassword', () => {
  let ctx: AuthTestContext;

  beforeEach(() => {
    ctx = setup();
  });

  it('throws InvalidTokenException when token is not found', async () => {
    ctx.verificationTokenRepository.findOne.mockResolvedValue(null);

    await expect(
      ctx.authService.resetPassword('badtoken', 'newpassword'),
    ).rejects.toThrow(InvalidTokenException);
  });

  it('throws TokenExpiredException when token is expired', async () => {
    const rawToken = 'c'.repeat(64);
    const record = makeVerificationToken({
      token_hash: crypto.createHash('sha256').update(rawToken).digest('hex'),
      type: VerificationTokenType.PASSWORD_RESET,
      used_at: null,
      expires_at: new Date(Date.now() - 1000),
      user: makeUser({ password: 'oldhash' }),
    });
    ctx.verificationTokenRepository.findOne.mockResolvedValue(record);

    await expect(
      ctx.authService.resetPassword(rawToken, 'newpassword'),
    ).rejects.toThrow(TokenExpiredException);
  });

  it('hashes the new password, marks token used, and revokes refresh tokens', async () => {
    const rawToken = 'd'.repeat(64);
    const user = makeUser({ password: 'oldhash' });
    const record = makeVerificationToken({
      token_hash: crypto.createHash('sha256').update(rawToken).digest('hex'),
      type: VerificationTokenType.PASSWORD_RESET,
      used_at: null,
      expires_at: new Date(Date.now() + 60_000),
      user,
    });
    ctx.verificationTokenRepository.findOne.mockResolvedValue(record);

    const qb = makeQueryBuilder();
    ctx.refreshTokenRepository.createQueryBuilder.mockReturnValue(
      asQueryBuilder<RefreshToken>(qb),
    );

    await ctx.authService.resetPassword(rawToken, 'newplaintext');

    expect(record.used_at).toBeInstanceOf(Date);
    expect(user.password).not.toBe('oldhash');
    expect(user.password).toMatch(/^\$argon2/);
    expect(ctx.verificationTokenRepository.save).toHaveBeenCalledWith(record);
    expect(ctx.usersService.save).toHaveBeenCalledWith(user);
    expect(qb.where).toHaveBeenCalledWith('user_id = :userId', {
      userId: 'u1',
    });
    expect(qb.execute).toHaveBeenCalled();
  });
});
