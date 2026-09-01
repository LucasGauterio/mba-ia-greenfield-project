import { DatabaseError } from 'pg';
import { QueryFailedError } from 'typeorm';

export const PG_UNIQUE_VIOLATION = '23505';

/**
 * Narrows an unknown error to pg's `DatabaseError` — TypeORM wraps it inside a
 * `QueryFailedError.driverError`, so both shapes are unwrapped here. Returns
 * `null` when the error is not a Postgres driver error.
 */
export function asPostgresError(err: unknown): DatabaseError | null {
  if (err instanceof DatabaseError) return err;
  if (
    err instanceof QueryFailedError &&
    err.driverError instanceof DatabaseError
  ) {
    return err.driverError;
  }
  return null;
}

/**
 * `true` when the error is a unique-constraint violation (SQLSTATE 23505).
 * Pass `column` to also require that the constraint detail names that column.
 */
export function isUniqueViolation(err: unknown, column?: string): boolean {
  const pgError = asPostgresError(err);
  if (!pgError || pgError.code !== PG_UNIQUE_VIOLATION) return false;
  if (!column) return true;
  return pgError.detail?.includes(column) ?? false;
}
