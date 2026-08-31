---
paths:
  - 'nestjs-project/src/**/*.ts'
  - 'nestjs-project/test/**/*.ts'
description: 'TypeScript strictness rules — keep tsc --noEmit clean at all times'
---

# TypeScript Rules

The project compiles with `strict` settings (`strictNullChecks`, etc.). `npx tsc --noEmit` must exit with code 0 before any task is considered done — never leave compilation errors as debt for a future cleanup task.

## Type-Only Imports

When an import is used **only** as a type (in annotations, generics, `extends`, `implements`), use `import type`:

```typescript
import type { JwtPayload } from './types/jwt-payload';
import type { ConfigType } from '@nestjs/config';
```

This avoids runtime imports of type-only modules (which can break with `verbatimModuleSyntax` / `isolatedModules`) and keeps the compiled output minimal.

If the same module exports both values and types, use the inline form:

```typescript
import { someFunction, type SomeType } from './module';
```

## NestJS ConfigType

When injecting a typed config built with `registerAs`, use `ConfigType<typeof myConfig>` from `@nestjs/config` — not `ReturnType<typeof myConfig>`:

```typescript
import authConfig from './auth.config';
import type { ConfigType } from '@nestjs/config';

constructor(
  @Inject(authConfig.KEY)
  private readonly config: ConfigType<typeof authConfig>,
) {}
```

`ConfigType` resolves promises returned by async factories; `ReturnType` does not.

## Strict Null Defaults

When reading optional env vars with `process.env.X` directly, narrow before use:

```typescript
const port = parseInt(process.env.PORT ?? '3000', 10);
```

Never rely on `parseInt(undefined)` or pass possibly-undefined values into APIs that require a defined argument.

## Library-Specific Type Casts

Some libraries use branded string types (`StringValue` from `ms`, etc.) that a plain `string` does not satisfy. Cast at the boundary where the value enters the library API rather than widening the source type. See `auth-jwt.md` for the JWT `expiresIn` example; the same principle applies to any branded-string library you integrate.

For typed config providers built with `registerAs`, see also the `typeorm-migrations.md` note on test `DataSource` entity arrays.

## Typing External/Driver Boundaries

When a value crosses into or out of an untyped external boundary (a driver error, a third-party callback payload, a raw HTTP response body), narrow it with `unknown` + `instanceof` against the library's own exported types — never `as any`:

```typescript
function isPostgresError(err: unknown): err is DatabaseError {
  return err instanceof DatabaseError;
}

try {
  await this.repository.save(entity);
} catch (err: unknown) {
  if (isPostgresError(err) && err.code === '23505') {
    throw new ConflictException('Already exists');
  }
  throw err;
}
```

See `src/common/database/postgres-error.ts` for the canonical implementation of this pattern against `pg`'s `DatabaseError`. Apply the same shape to any other external boundary you introduce (a new driver, a new third-party SDK callback) instead of inventing a new `as any` cast.

## Scoped Exceptions Only — Never a Blanket Rule Toggle

If existing code can't satisfy a rule yet, the fix is a **scoped, tracked exception** — never a project-wide `off`/`warn` in `eslint.config.mjs` or a loosened `tsconfig.json` flag. A blanket toggle silently normalizes debt for every future file, not just the ones that actually need the exception (this is exactly how `no-explicit-any: 'off'` accumulated 504 untracked lint problems before a dedicated cleanup task caught it).

To defer a specific, already-identified problem:

1. Add an entry to `docs/known-issues.md` naming the exact files and rule, why it's deferred, and a follow-up.
2. Scope the ESLint exception to those exact files via an `overrides`/`files`-glob block (not a top-level rule change), with a comment linking to the ledger entry.
3. Remove the override and the ledger entry together once fixed — never leave an orphaned override after its issue is resolved.

The only currently-sanctioned project-wide relaxation is the test-file swap of `@typescript-eslint/unbound-method` for `jest/unbound-method` in `eslint.config.mjs` (documented false-positive on `expect(mock.method)`, not a debt exception) — everything else follows the scoped process above.