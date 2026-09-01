import { ExecutionContext } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';

const TEST_SECRET = 'test-secret';

function makeContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('OptionalJwtAuthGuard', () => {
  let guard: OptionalJwtAuthGuard;
  let jwtService: JwtService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: TEST_SECRET,
          signOptions: { expiresIn: '15m' },
        }),
      ],
      providers: [OptionalJwtAuthGuard],
    }).compile();

    guard = module.get(OptionalJwtAuthGuard);
    jwtService = module.get(JwtService);
  });

  it('authorizes an anonymous request and leaves request.user undefined', async () => {
    const request: Record<string, unknown> = { headers: {} };
    const ctx = makeContext(request);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.user).toBeUndefined();
  });

  it('authorizes and populates request.user for a valid Bearer token', async () => {
    const token = jwtService.sign({ sub: 'user-1', email: 'a@example.com' });
    const request: Record<string, unknown> = {
      headers: { authorization: `Bearer ${token}` },
    };
    const ctx = makeContext(request);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect((request.user as Record<string, unknown>).sub).toBe('user-1');
  });

  it('authorizes but leaves request.user undefined for an invalid token', async () => {
    const request: Record<string, unknown> = {
      headers: { authorization: 'Bearer not-a-valid-jwt' },
    };
    const ctx = makeContext(request);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.user).toBeUndefined();
  });
});
