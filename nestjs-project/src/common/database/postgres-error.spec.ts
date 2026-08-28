import { QueryFailedError } from 'typeorm';
import {
  PG_UNIQUE_VIOLATION,
  isPostgresError,
  isUniqueViolation,
} from './postgres-error';

function makeQueryFailedError(
  props: Record<string, unknown>,
): QueryFailedError {
  const err = new QueryFailedError('INSERT', [], new Error('driver'));
  return Object.assign(err, props);
}

describe('postgres-error', () => {
  describe('isPostgresError', () => {
    it('accepts an object with a string `code`', () => {
      expect(isPostgresError({ code: '23505' })).toBe(true);
    });

    it('rejects null, undefined and primitives', () => {
      expect(isPostgresError(null)).toBe(false);
      expect(isPostgresError(undefined)).toBe(false);
      expect(isPostgresError('boom')).toBe(false);
      expect(isPostgresError(42)).toBe(false);
    });

    it('rejects an object whose `code` is not a string', () => {
      expect(isPostgresError({ code: 23505 })).toBe(false);
      expect(isPostgresError({ detail: 'x' })).toBe(false);
    });
  });

  describe('isUniqueViolation', () => {
    it('is true for a QueryFailedError carrying code 23505', () => {
      const err = makeQueryFailedError({ code: PG_UNIQUE_VIOLATION });
      expect(isUniqueViolation(err)).toBe(true);
    });

    it('is true when the column is mentioned in `detail`', () => {
      const err = makeQueryFailedError({
        code: PG_UNIQUE_VIOLATION,
        detail: 'Key (slug)=(abc1234567) already exists.',
      });
      expect(isUniqueViolation(err, 'slug')).toBe(true);
    });

    it('is false when a different column violated the constraint', () => {
      const err = makeQueryFailedError({
        code: PG_UNIQUE_VIOLATION,
        detail: 'Key (nickname)=(chan) already exists.',
      });
      expect(isUniqueViolation(err, 'slug')).toBe(false);
    });

    it('is false for a non-unique-violation code', () => {
      const err = makeQueryFailedError({ code: '23503' });
      expect(isUniqueViolation(err)).toBe(false);
    });

    it('reads the code from `.driverError` when not on the wrapper', () => {
      const err = new QueryFailedError(
        'INSERT',
        [],
        Object.assign(new Error('dup'), { code: PG_UNIQUE_VIOLATION }),
      );
      expect(isUniqueViolation(err)).toBe(true);
    });

    it('accepts a bare driver error object (not wrapped)', () => {
      expect(
        isUniqueViolation(
          { code: PG_UNIQUE_VIOLATION, detail: 'Key (slug)=' },
          'slug',
        ),
      ).toBe(true);
    });

    it('is false for null / non-error values', () => {
      expect(isUniqueViolation(null)).toBe(false);
      expect(isUniqueViolation(new Error('plain'))).toBe(false);
      expect(isUniqueViolation('nope')).toBe(false);
    });
  });
});
