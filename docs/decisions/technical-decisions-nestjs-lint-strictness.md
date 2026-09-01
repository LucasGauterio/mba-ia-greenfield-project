---
scope_type: ad-hoc
related_phases: []
status: pending
date: 2026-09-01
scope_description: "Close KI-1 (no-unsafe-* lint violations in phase 01-02 test files) and KI-2 (Prettier CRLF failures) from docs/known-issues.md so the backend is fully and correctly typed with zero lint errors/warnings on the affected files"
---

# Technical Decisions — NestJS Lint Strictness Cleanup

_Subprojects in scope:_

- `nestjs-project/` — the only subproject with runnable code; every TD below targets files or tooling under this directory.
- `next-frontend/` — not yet initialized; no open decision here. TD-03's `.gitattributes` mechanism is repo-root and will apply automatically once this subproject exists — no separate TD needed now.

**Trigger (context shared by all TDs below).** `docs/known-issues.md` currently tracks two open, time-boxed exceptions inherited from phase-01/phase-02, both explicitly earmarked for a dedicated `bugfix/nestjs-lint-strictness` task:

- **KI-1** — ~147 `@typescript-eslint/no-unsafe-*` violations across 9 test files (measured 2026-08-31), almost entirely from untyped Jest mock objects (`useValue: { method: jest.fn() }`) and one untyped `res.body` read pattern in `test/auth.e2e-spec.ts` (48 of the 147).
- **KI-2** — ~66 `.ts` files fail `npm run format:check` on Windows checkouts due to CRLF line endings, because `.gitattributes` does not pin `.ts` files to `eol=lf`.

Both KIs explicitly forbid the fix that already caused the original 504-problem debt (`eslint.config.mjs` project-wide `off`/`warn` toggles, per `.claude/rules/typescript-strict.md` → "Scoped Exceptions Only") — the fix must actually retype the affected code, not further relax the linter. One file in KI-1's list, `src/channels/channels.service.ts` (6 errors), is **not** covered by a TD here: its `const e = err as any;` cast is a direct instance of the pattern `typescript-strict.md` → "Typing External/Driver Boundaries" already documents a canonical fix for (`err instanceof`-narrowed guard, as implemented in `src/common/database/postgres-error.ts`) — it is single-file, best-practices-resolvable, and does not need a strategic decision; the implementer applies the existing documented pattern directly.

---

## TD-01: Type-safe test-double strategy for NestJS unit/integration specs

**Scope:** Backend

**Trigger:** KI-1 attributes the bulk of its ~147 violations to untyped Jest mock objects across `src/auth/auth.service.spec.ts`, `src/mail/mail.service.integration-spec.ts`, `src/channels/channels.service.spec.ts`, `src/auth/auth.service.integration-spec.ts`, `src/common/filters/*.spec.ts`, and `src/users/users.service.integration-spec.ts`. The project's existing mocking convention (`.claude/skills/testing-guide-nestjs-project/references/mock-health-rules.md` → "Preferred: `useValue` in test module") is `{ provide: UsersService, useValue: { findByEmail: jest.fn() } }` — TypeScript infers a loose object-literal type for that `useValue`, so every later `.mockResolvedValue(...)`, `.mock.calls[0][0]`, or chained property access on it degrades to `any` and trips `no-unsafe-assignment`/`no-unsafe-member-access`/`no-unsafe-call`/`no-unsafe-return`. No existing rule or skill (`mock-health-rules.md`, `gotchas.md`) documents how to type this mock object, so this needs a decision, not just an application of an existing pattern.

**Options:**

### Option A: `@golevelup/ts-jest`'s `createMock<T>()`
- Generates a fully-typed `DeepMocked<T>` for any interface/class — every method pre-stubbed as `jest.fn()` — and only the methods a given test cares about need overriding, e.g. `createMock<UsersService>({ findByEmail: jest.fn().mockResolvedValue(user) })`. This is the library's documented purpose for exactly the NestJS-DI `useValue` slot.
- **Pros:** Purpose-built for this NestJS + Jest combination (golevelup's own docs demonstrate it plugged straight into `useValue`); preserves the project's existing partial-mock convention almost verbatim — no rewrite of test intent, just the mock's construction; widely used in the NestJS ecosystem, so a maintainer coming from another NestJS codebase already knows the pattern.
- **Cons:** Adds a new dev dependency; optional `strict: true` mode (throws on any unstubbed call) needs an explicit per-test opt-in decision the project doesn't need to make immediately.

### Option B: Native `jest.Mocked<T>` / `jest.mocked()` (built into Jest 30, no new dependency)
- Declare `const mockUsersService: jest.Mocked<UsersService> = { findByEmail: jest.fn(), ...every other member };`, or wrap an already-real object with `jest.mocked(obj)`.
- **Pros:** Zero new dependency — ships with the installed Jest 30 / `@types/jest` ^30; first-party, no third-party maintenance risk.
- **Cons:** `jest.Mocked<T>` requires supplying every member the interface exposes to satisfy the type, not just the ones the test actually uses — friction against the project's existing partial-mock style. `jest.mocked()` is designed to wrap an object obtained via `jest.mock()` auto-mocking, which `.claude/skills/testing-guide-nestjs-project/references/gotchas.md` (#8) explicitly tells this project to avoid in favor of DI `useValue`.

### Option C: Hand-written per-file typed mock interfaces (no library)
- Declare a narrowed type per test file, e.g. `type MockedUsersService = Pick<jest.Mocked<UsersService>, 'findByEmail'>`.
- **Pros:** No dependency at all.
- **Cons:** Repeats boilerplate in every one of the 9 affected files (and every future spec) with no single source of truth — the same drift risk the retrospective in `technical-decisions-workflow-hardening-guardrails.md` was written to prevent, just at file-by-file granularity instead of config-level.

**Recommendation:** **Option A** — `@golevelup/ts-jest` is purpose-built for the DI `useValue` partial-mock pattern this project already standardizes on (`mock-health-rules.md`), giving full type safety without abandoning that convention or forcing every mock to enumerate an entire interface's surface.

**Decision:** `@golevelup/ts-jest` `createMock<T>()`

---

## TD-02: Typing strategy for supertest e2e response bodies

<!-- status: superseded-by: nestjs-lint-strictness/TD-04 -->

**Scope:** Backend

**Trigger:** KI-1 attributes 48 of its ~147 violations to `test/auth.e2e-spec.ts` alone, all from reading `res.body.<field>` — `@types/supertest` types `Response.body` as `any`, so every property read on it trips `no-unsafe-member-access`/`no-unsafe-assignment`. This pattern will recur in every future `*.e2e-spec.ts` file, not just this one.

**Context:** The auth endpoints under test currently return plain objects (`{ access_token, refresh_token }`) with no response DTO class — only request DTOs exist (`src/auth/dto/*.ts`) — so there is no existing production type to import for a direct cast.

**Options:**

### Option A: Per-assertion cast through `unknown` to a locally-declared shape
- `const body = res.body as unknown as { access_token: string; refresh_token: string };` written at each call site (or once per `describe` block).
- **Pros:** No new abstraction or shared file; mirrors the `unknown` + narrow boundary pattern already codified in `.claude/rules/typescript-strict.md` → "Typing External/Driver Boundaries"; zero production code changes.
- **Cons:** The response shape gets redeclared wherever it's read unless someone deliberately hoists and reuses it — risk of two assertions in the same file silently drifting apart.

### Option B: A single reusable typed helper (`function typedBody<T>(res: Response): T`) in `src/test/`
- One helper, colocated with the project's existing test utilities (`src/test/create-test-data-source.ts`, `src/test/mailpit.ts`); call sites become `typedBody<{ access_token: string; refresh_token: string }>(res)`.
- **Pros:** Centralizes the "trusted boundary cast" in one reviewed place instead of scattering it across 48+ call sites; consistent pattern for every current and future e2e spec; fits the project's existing `src/test/` convention for shared test infrastructure.
- **Cons:** A small amount of new shared test-utility surface (one helper function) that every e2e spec author needs to know to reach for.

### Option C: Real response DTO classes on the controllers + `plainToInstance` runtime validation in tests
- Define `LoginResponseDto` etc. on the endpoints themselves; deserialize and validate `res.body` against the class at runtime in each test.
- **Pros:** Strongest guarantee available — catches actual API response-contract drift at test time, not just a compile-time label with no runtime backing.
- **Cons:** Expands scope from "fix test-file typing debt" into adding new production response DTOs across every auth endpoint — new production surface, not a test-only fix, which conflicts with `CLAUDE.md` → "Scope Limits" for what this task is: a debt-cleanup, not a feature change.

**Recommendation:** **Option B** — keeps the fix entirely inside the test layer (no new production DTOs) while still centralizing the boundary cast in one reusable place, which scales better to the other 8 files and any future `*.e2e-spec.ts` than Option A's per-callsite repetition, without the scope expansion Option C introduces.

**Decision:** Reusable `typedBody<T>()` helper in `src/test/

---

## TD-03: Repo-wide line-ending normalization strategy

**Scope:** Repo-wide

**Trigger:** KI-2 — ~66 `.ts` files fail `npm run format:check` on a Windows checkout because `core.autocrlf=true` and the repo's `.gitattributes` only pins `*.sh` to `eol=lf`; every `.ts` file checks out CRLF while the root `.prettierrc` has no `endOfLine` override (Prettier defaults to `lf`). Note: `nestjs-project/eslint.config.mjs`'s own Prettier integration already sets `endOfLine: "auto"` for `npm run lint`'s embedded Prettier check, but the standalone `npm run format:check` script (`prettier --check "src/**/*.ts" "test/**/*.ts"`) reads `.prettierrc` directly and still fails — the two configs currently disagree, and only one of them is fixed.

**Options:**

### Option A: `.gitattributes` `*.ts text eol=lf` + one-time `git add --renormalize .`, plus `"endOfLine": "auto"` added to `.prettierrc`
- Fixes the root cause at the checkout layer: every clone/checkout, on any OS, gets LF `.ts` files going forward, regardless of a contributor's local `core.autocrlf`. The `.prettierrc` addition is defense-in-depth so `format:check` tolerates any file that still slips through with a different line ending.
- **Pros:** Matches KI-2's own root-cause diagnosis exactly; permanent and OS-independent; also protects `next-frontend/`'s `.ts`/`.tsx` files once that subproject is initialized, with no additional TD needed then.
- **Cons:** The renormalization touches every tracked `.ts` file's line endings in a single commit (line-ending-only diff, no content change) — per `CLAUDE.md` → "Scope Limits" this must land as its own isolated commit, separate from any functional lint fix.

### Option B: `.prettierrc`'s `"endOfLine": "auto"` only, no `.gitattributes` change
- Makes Prettier accept whichever line ending a file already has instead of enforcing one.
- **Pros:** Minimal diff (one config line); no repo-wide renormalization commit needed.
- **Cons:** Leaves the repo's actual checked-out line endings genuinely inconsistent across contributors/OSes (still governed only by each person's local `core.autocrlf`); does not fix the root cause, only widens the Prettier check's tolerance around it — `git diff`/`blame` can still show spurious whole-file line-ending noise whenever a file crosses between a CRLF-checkout and an LF-checkout contributor, which is exactly what `.gitattributes` exists to prevent.

**Recommendation:** **Option A** — `.gitattributes` is the mechanism that actually controls checkout line endings (the documented root cause), while Option B only relaxes the symptom-level check and leaves the repo's real line endings inconsistent across contributors and the not-yet-initialized frontend subproject.

**Decision:** `.gitattributes` `eol=lf` + renormalize + `.prettierrc` `endOfLine: auto`

---

## TD-04: Typing strategy for supertest e2e response bodies (revised)

**Trigger:** Supersedes `nestjs-lint-strictness/TD-02`. `/plan-validate` raised ICC-1 during resolve: TD-02 decided a shared `typedBody<T>()` helper, but `test/videos.e2e-spec.ts` (landed in phase-03-videos, already lint-clean) established a different, already-working convention — a local `interface` declared per response shape directly in the spec file, with a direct cast at each call site (`const body = res.body as InitiateUploadBody;`), no shared helper and no `unknown` intermediate hop. Confirmed by inspection during `/plan-resolve` (2026-09-01): `test/videos.e2e-spec.ts` lines 16-28 declare `InitiateUploadBody`, `ErrorBody`, `CompleteUploadBody`, `VideoViewBody` locally; lines 111-344 cast directly (`res.body as X`) at each read site.

**Scope:** Backend

**Context:** TD-02's own "Option A" was close but not identical to the established pattern — it specified a double-cast through `unknown` (`res.body as unknown as {...}`), which the real convention doesn't use (TypeScript allows a direct `any → NamedInterface` cast without an `unknown` hop, and it still satisfies `no-unsafe-*` since the assertion removes the `any` typing from that point forward). Choosing this over TD-02's shared-helper Option B keeps the entire e2e suite — old and newly-retyped files alike — on one identical convention, with zero new shared test-utility surface.

**Recommendation:** matching the already-established, already-lint-clean `test/videos.e2e-spec.ts` convention avoids introducing a second competing pattern for the same problem — one convention for the whole e2e suite beats TD-02's shared helper, which would have made the codebase's newest test files diverge from its most recent precedent.

**Decision:** Match `test/videos.e2e-spec.ts` exactly: declare a local `interface` per response shape in each `*.e2e-spec.ts` file being retyped (e.g. `interface LoginResponseBody { access_token: string; refresh_token: string }` in `test/auth.e2e-spec.ts`), and cast directly at each call site: `const body = res.body as LoginResponseBody;`. No `src/test/` helper is introduced; `test/videos.e2e-spec.ts` itself is left untouched (already compliant, out of this task's file list).

**Libraries:** —

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Type-safe test-double strategy for NestJS specs | `@golevelup/ts-jest` `createMock<T>()` | `@golevelup/ts-jest` `createMock<T>()` |
| TD-02 | Backend | Typing strategy for supertest e2e response bodies | Reusable `typedBody<T>()` helper in `src/test/` | _superseded by TD-04_ |
| TD-03 | Repo-wide | Line-ending normalization strategy | `.gitattributes` `eol=lf` + renormalize + `.prettierrc` `endOfLine: auto` | `.gitattributes` `eol=lf` + renormalize + `.prettierrc` `endOfLine: auto` |
| TD-04 | Backend | Typing strategy for supertest e2e response bodies (revised) | — _(born decided during /plan-resolve)_ | Match `test/videos.e2e-spec.ts`'s local-interface + direct-cast convention |
