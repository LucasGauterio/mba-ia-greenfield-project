import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { BEARER_PREFIX } from '../auth.constants';
import { JwtPayload } from '../auth.types';

/**
 * Decodes a Bearer token when one is present and attaches `request.user`, but
 * **always** authorizes the request. Used with `@Public()` on the video read
 * routes so an owner can be recognised while anonymous callers still get
 * through — the visibility rule (404-never-403) lives in `VideosService`
 * (phase-03-videos/TD-09, PLAN §11.5).
 */
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ headers?: Record<string, string>; user?: JwtPayload }>();
    const authHeader = request.headers?.authorization;

    if (authHeader?.startsWith(BEARER_PREFIX)) {
      const token = authHeader.slice(BEARER_PREFIX.length);
      try {
        request.user = await this.jwtService.verifyAsync<JwtPayload>(token);
      } catch {
        // Invalid/expired token on an optional route → treat as anonymous.
      }
    }

    return true;
  }
}
