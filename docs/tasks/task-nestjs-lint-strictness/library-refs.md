---
libs:
  "typescript-eslint":
    version: "^8.20.0"
    context7_id: "/typescript-eslint/typescript-eslint"
    fetched_at: "2026-08-28T13:41:00-03:00"
  "eslint-plugin-jest":
    version: "pending-install (^28 — ESLint 9 / flat-config compatible)"
    context7_id: "n/a — no dedicated Context7 source; setup covered via /typescript-eslint/typescript-eslint integration docs"
    fetched_at: "2026-08-28T13:41:00-03:00"
  "@golevelup/ts-jest":
    version: "pending-install (latest)"
    context7_id: "/websites/golevelup_github_io_nestjs"
    fetched_at: "2026-08-28T13:41:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-nestjs-lint-strictness.md: "2026-08-28T13:40:22-03:00"
---

# Library References — task-nestjs-lint-strictness

Cache of Context7-fetched docs for libraries decided in this task's TDs. Focus is on the surfaces the TDs actually touch: flat-config rule-set selection, per-file overrides, and typed Jest mocking.

## typescript-eslint

**Decided in:** TD-01 (Decision B — adopt `tseslint.configs.strictTypeChecked`). Installed: `typescript-eslint@^8.20.0` (devDependency, already present).

### strictTypeChecked vs recommendedTypeChecked

- `strictTypeChecked` = `recommended` + `recommendedTypeChecked` + `strict` + extra type-aware rules. Sets (among others) `@typescript-eslint/no-explicit-any: error`, `no-unsafe-function-type: error`, `no-unused-vars: error`, `no-non-null-assertion: error`, plus `no-unnecessary-condition`, `prefer-nullish-coalescing`, `no-unnecessary-type-assertion`, `no-unnecessary-boolean-literal-compare`, `no-unnecessary-type-parameters`, etc.
- Officially **"not stable under Semantic Versioning"** — minor typescript-eslint releases may add/tighten rules. Expect lint churn on dependency bumps; pin `typescript-eslint` and review its changelog before upgrading.
- The three currently-suppressed rules (`no-explicit-any`, `no-floating-promises`, `no-unsafe-argument`) all return to `error` under this config with no override needed — delete the override block.

### Flat-config shape (ESLint 9)

```js
// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import jestPlugin from 'eslint-plugin-jest';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';

export default tseslint.config(
  { ignores: ['eslint.config.mjs', 'dist/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,   // was: ...tseslint.configs.recommendedTypeChecked
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
      sourceType: 'commonjs',
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    // enable jest rules on test files (TD-04)
    files: ['**/*.spec.ts', '**/*.integration-spec.ts', 'test/**/*.ts'],
    extends: [jestPlugin.configs['flat/recommended']],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
      'jest/unbound-method': 'error',
    },
  },
  { rules: { 'prettier/prettier': ['error', { endOfLine: 'auto' }] } },
);
```

### Typed linting for root-level JS config files

`projectService: true` handles files in `tsconfig.json`. For root `*.js`/`*.mjs` config files not in the TS project, either keep them in `ignores` (current approach — `eslint.config.mjs` is already ignored) or use `projectService: { allowDefaultProject: ['*.js'] }`.

### `disableTypeChecked` for non-TS files

If any `.js` slips into lint scope, add a trailing override: `{ files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] }`.

### `no-non-null-assertion` (part of strictTypeChecked)

Flags existing `!` uses (`video.upload_id!`, `etag!`, `res.headers.get('etag')!`). Each needs an explicit narrow (`if (!x) throw ...`) or a typed helper — no blanket disable. This is the "escape hatch" closure the task targets.

## eslint-plugin-jest

**Decided in:** TD-04 (Decision B). Not yet installed — add as devDependency (`^28` or newer for ESLint 9 flat-config support).

### Why it's added (not a shortcut)

`@typescript-eslint/unbound-method` fires on `expect(mock.method)` in specs — a false positive the typescript-eslint docs themselves flag: *"For projects using jest, consider using eslint-plugin-jest's version of this rule … it understands when it is acceptable to pass an unbound method to `expect` calls."* Swap is a correction, not a relaxation.

### Setup (flat config, ESLint 9 + typescript-eslint 8)

- Register the plugin: `plugins: { jest: jestPlugin }` (implicit when using `extends: [jestPlugin.configs['flat/recommended']]`).
- Scope to test files only via `files: [...]`.
- `jestPlugin.configs['flat/recommended']` adds: `jest/no-disabled-tests`, `jest/no-focused-tests`, `jest/no-identical-title`, `jest/valid-expect`, `jest/valid-title`, `jest/no-conditional-expect`, `jest/expect-expect`, etc. — all net quality gains.
- Turn `@typescript-eslint/unbound-method` off and `jest/unbound-method` on **within the test-file override block only** — the TS rule stays `error` for production code.

### Version note

`eslint-plugin-jest` moved flat-config exports (`configs['flat/recommended']`) in v28. With ESLint 9 + `typescript-eslint@8`, use the latest v28+/v29. Verify peer-deps against the installed `jest@^30` at install time.

## @golevelup/ts-jest

**Decided in:** TD-05 (Decision B — `createMock<T>()`). Not yet installed — add as devDependency.

### Core usage — replaces the `any` mock factories

```typescript
import { createMock } from '@golevelup/ts-jest';
import { StorageService } from './storage.service';
import type { Repository } from 'typeorm';
import type { Video } from './entities/video.entity';

const storage = createMock<StorageService>();
const videoRepo = createMock<Repository<Video>>();

// every method is a typed jest.Mock returning a mock proxy
storage.createMultipartUpload.mockResolvedValue('upload-123');
videoRepo.findOneBy.mockResolvedValue(null);

const service = new VideosService(videoRepo, channelsSvc, storage, boss);
```

- `createMock<T>()` returns a **fully typed** deep mock — all methods/sub-properties are `jest.fn()` unless supplied. Eliminates `function makeStorageService(): any { ... }` and the `as StorageService` casts that cascade into `no-unsafe-*`.
- Accepts a partial implementation as the first arg: `createMock<ExecutionContext>({ switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: 'auth' } }) }) })`.
- `createMock<T>({}, { strict: true })` throws on any unstubbed method call — opt in per spec where you want to assert exact interactions.
- **Call-count caveat:** when you stub a chained method (e.g. `switchToHttp().getResponse`), the calls made to set up the mock count toward `toBeCalledTimes(...)` assertions on the parent.

### Where it also helps in this task's specs

Guard / interceptor / filter specs (`domain-exception.filter.spec.ts`, `auth` guard specs) that currently build `ExecutionContext` / `ArgumentsHost` by hand with `any` — `createMock<ExecutionContext>()` / `createMock<ArgumentsHost>()` gives typed versions.

### NestJS provider override

```typescript
{ provide: MailService, useValue: createMock<MailService>() }
```
Use in `Test.createTestingModule({ providers: [...] })` instead of hand-rolled `useValue: { sendX: jest.fn() }` objects.
