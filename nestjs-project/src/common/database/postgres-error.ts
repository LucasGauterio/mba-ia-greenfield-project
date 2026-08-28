import { QueryFailedError } from 'typeorm';

/**
 * Shape of a `pg` driver error. TypeORM copies these fields onto its
 * {@link QueryFailedError} instance (via `ObjectUtils.assign`), and also keeps
 * the raw driver error on `.driverError`.
 */
export interface PostgresError {
  code: string;
  detail?: string;
  constraint?: string;
  table?: string;
  column?: string;
}

/** SQLSTATE code for a unique-constraint violation. */
export const PG_UNIQUE_VIOLATION = '23505';

/** Narrows an unknown thrown value to a Postgres driver error. */
export function isPostgresError(err: unknown): err is PostgresError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as Record<string, unknown>).code === 'string'
  );
}

/**
 * True when `err` represents a Postgres unique-constraint violation
 * (SQLSTATE `23505`). When `column` is given, the violated constraint's
 * `detail` message must also mention that column — this disambiguates which
 * unique index failed when a table has more than one.
 */
export function isUniqueViolation(err: unknown, column?: string): boolean {
  const candidates: unknown[] =
    err instanceof QueryFailedError ? [err, err.driverError] : [err];

  return candidates.some((candidate) => {
    if (!isPostgresError(candidate)) return false;
    if (candidate.code !== PG_UNIQUE_VIOLATION) return false;
    if (column === undefined) return true;
    return (
      typeof candidate.detail === 'string' && candidate.detail.includes(column)
    );
  });
}
