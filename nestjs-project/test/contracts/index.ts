/**
 * Response-body contracts for the e2e suites. `supertest` types `res.body` as
 * `any`; specs cast it once at the assertion site — `(res.body as AuthTokens)` —
 * using the interfaces below so individual property accesses stay type-safe.
 */

export type {
  InitiateUploadPart,
  InitiateUploadResult,
  CompleteUploadResult,
  VideoDetailResult,
} from '../../src/videos/videos.service';

/**
 * Error envelope emitted by `DomainExceptionFilter` / `ValidationExceptionFilter`
 * (mirrors `src/common/openapi/api-error-envelope.dto.ts`).
 */
export interface ErrorEnvelope {
  statusCode: number;
  error: string;
  message: string | string[];
  code?: string;
}

/** `POST /auth/login` and `POST /auth/refresh` response body. */
export interface AuthTokens {
  access_token: string;
  refresh_token: string;
}

/** `POST /auth/register` response body. */
export interface RegisterResponse {
  id: string;
  email: string;
}

/** `GET /auth/me` response body (the decoded JWT payload). */
export interface MeResponse {
  sub: string;
  email: string;
}
