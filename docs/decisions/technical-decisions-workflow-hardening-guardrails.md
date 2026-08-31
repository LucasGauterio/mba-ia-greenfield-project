---
scope_type: ad-hoc
related_phases: []
status: decided
date: 2026-08-31
scope_description: "Harden the planning/implementation workflow (CLAUDE.md, plan-pipeline skills, implement-phase, agents, rules) against the failure pattern found in a retrospective of the phase-03-videos + bugfix/nestjs-lint-strictness sessions"
---

# Technical Decisions — Workflow Hardening Guardrails

_Subprojects in scope:_

- `nestjs-project/` — receives the new `env-check.sh` / `smoke-test.sh` scripts and the `lint:ci` / `format:check` npm scripts; the only subproject with runnable code today.
- `next-frontend/` — not yet initialized. TD-03/TD-04's scripts are backend-only for now; the same pattern (one-command env check, one-command smoke test) should be replicated here once the subproject exists — no TD opens that work now, it's future scope.
- `.claude/skills/`, `.claude/agents/`, `.claude/rules/`, `CLAUDE.md` — process/tooling, not a runnable subproject, but the primary surface this document's decisions actually change.

**Retrospective trigger (context shared by all TDs below).** Mining the Claude Code session transcripts for phase-03-videos and the follow-up `bugfix/nestjs-lint-strictness` cleanup (not just `git log`) surfaced a repeating pattern: `eslint.config.mjs` shipped with `no-explicit-any: 'off'` from day one, normalized as an "intentional convention" in `nestjs-project/CLAUDE.md`, while `.claude/rules/typescript-strict.md` simultaneously claimed the project already compiled under `strict` — a documented-vs-real contradiction nobody caught until a dedicated audit measured **504 lint problems across 16 files**. `implement-phase` never named lint as a mandatory gate, only test/tsc/build "typically" ran. A pre-phase-03 session found 150 pre-existing lint errors from phase 02, flagged them, and the user chose to defer — nothing forced that decision to be recorded anywhere. Environment issues (Docker not running, `.env` gaps, ESM-only packages silently breaking Jest, a migration cleanup bug) were re-diagnosed from scratch across multiple sessions. Commits were not made per-SI until the user manually interrupted implementation to ask for them. And `main` ended up with a premature merge of partial phase-3 work, requiring a reset to its fork-point commit earlier in this same effort. Each TD below closes one specific piece of that pattern.

---

## TD-01: Repository Health Check — scope and dispatch

**Scope:** Repo-wide

**Trigger:** How should the workflow verify lint/environment health before new work starts, without becoming the kind of heavy gate that gets bypassed or resented?

**Context:** The retrospective's clearest gap is that nothing in the pipeline checked repository health before planning or implementing — pre-existing lint debt was discovered once, informally, then silently carried forward. The fix needs to run automatically, but the pipeline's own conventions (see `plan-pipeline/SKILL.md` "Read strategy rules") already warn against heavy per-invocation costs; a check that takes minutes on every `/plan-context` or `implement-phase` run defeats its own purpose by training users to skip or route around it.

**Options:**

### Option A: Lightweight, advisory check (env-check + `lint:ci` only), `implement-phase` Preflight only
- Runs two fast commands (`env-check.sh`, `npm run lint:ci`) — seconds, not minutes. Reports findings; only prompts the user when something is both failing and untracked in `docs/known-issues.md`. Dispatched once, at `implement-phase` Preflight. `plan-context` does a plain, near-zero-cost file read of `docs/known-issues.md` instead of running the check itself.
- **Pros:** Cheap enough to run unconditionally. Never blocks a planning session that isn't touching code. Advisory framing (surface + ask, don't auto-abort) keeps the user in control of the fix-vs-defer call, which is itself one of the retrospective's lessons (the user's decision to defer phase-02's debt was legitimate — what was missing was that it never got recorded, not that it was forbidden).
- **Cons:** Does not catch `tsc` or test regressions before implementation starts — those still surface later, at `implement-phase`'s existing Final Verification.

### Option B: Full gate (env-check + `lint:ci` + `tsc --noEmit` + full test suite), hard-abort on any untracked finding, dispatched at both `plan-context` and `implement-phase`
- Every planning or implementation kickoff runs the complete Definition-of-Done check set and refuses to proceed until every finding is either clean or explicitly ledgered.
- **Pros:** Closest to a true CI gate; nothing untracked survives.
- **Cons:** Multi-minute tax on every single pipeline invocation, including ones that never touch code (`/plan-context` for a docs-only task). A hard abort with no lighter path is exactly the kind of friction that historically gets bypassed rather than fixed — the retrospective shows debt got *deferred*, not *ignored outright*; a wall that offers no deferral path just pushes people to work around the tool instead of through it.

**Recommendation:** **Option A** — matches the pipeline's existing read-budget discipline and keeps the check something people actually run every time instead of disabling.

**Decision:** A (lightweight, advisory, `implement-phase`-only dispatch)

**Revisions:**

- 2026-08-31 — Initial implementation attempt used Option B's shape (full test suite, hard abort, dispatched from both `plan-context` and `implement-phase`). Reworked to Option A after review flagged it as too heavy/blocking. _Rationale:_ a gate people route around provides less protection than a lighter one people keep running.

---

## TD-02: Deferred-debt tracking mechanism

**Scope:** Repo-wide

**Trigger:** When a health check (TD-01) finds something not caused by the current work, how should that be recorded so it doesn't quietly become permanent, the way `no-explicit-any: 'off'` did?

**Context:** The core failure this document exists to prevent is a config-level, project-wide, undated exception (`eslint.config.mjs`'s three relaxed rules) standing in for what should have been a scoped, time-boxed, visible decision. Any replacement mechanism needs to make deferral an explicit, reviewable act rather than a silent default.

**Options:**

### Option A: `docs/known-issues.md` — a dedicated ledger file
- One markdown file, `## OPEN` / `## RESOLVED` sections, each entry naming exact files/rule, origin phase, reason, and a follow-up. Read by the Repository Health Check (TD-01) and, informationally, by `phases-reader`/`plan-context` so prior-phase debt surfaces during planning of later phases.
- **Pros:** Single source of truth, git-diffable, lives next to the other `docs/` artifacts this project already treats as authoritative (decisions docs, project-plan). Cheap to read (one small file) regardless of how many phases exist.
- **Cons:** Another file to keep in sync; nothing stops someone from forgetting to move a resolved entry to `## RESOLVED`.

### Option B: Inline `// eslint-disable-next-line` comments with a tracking note
- Suppress at the exact line, with a comment linking to a follow-up.
- **Pros:** Zero new files; the exception lives right next to the code it exempts.
- **Cons:** Invisible in aggregate — there's no single place to see "what debt does this repo currently carry," which is exactly the visibility this document is trying to create. Also does not fit the observed debt shape: the lint-strictness audit found **zero** existing `// eslint-disable` comments — the actual debt was 100% config-level, so an inline-comment mechanism wouldn't have prevented what actually happened.

### Option C: GitHub Issues only, no in-repo file
- Track deferred debt as GitHub issues.
- **Pros:** Familiar tooling, supports assignment/labels/notifications.
- **Cons:** Not visible to an agent working locally without additional GitHub API tooling; the pipeline's existing convention is that everything the pipeline reads and gates on lives in `docs/` as plain files (decisions docs, project-plan, progress files) — an external tracker breaks that pattern for no clear benefit at this project's current scale.

**Recommendation:** **Option A** — consistent with the project's existing all-state-lives-in-docs/ convention and directly readable by both the health check and the planning pipeline's inheritance mechanism (TD-... see `phases-reader.md`).

**Decision:** A (`docs/known-issues.md` ledger)

**Revisions:**

- 2026-08-31 — Scoped-exception authoring guidance (how to actually write a `docs/known-issues.md`-linked ESLint override) was first drafted for `.claude/skills/plan-rule-author/SKILL.md`, then moved to `.claude/rules/typescript-strict.md`. _Rationale:_ `plan-rule-author` scaffolds the planning pipeline's own `docs/rules/{plan-validate,plan-build,plan-resolve}/` dispatch rules — a different concern entirely from project ESLint/tsconfig conventions. `typescript-strict.md` is the file actually auto-attached (via its `paths:` frontmatter) whenever `nestjs-project/src/**/*.ts` or `test/**/*.ts` is edited, making it the correct trigger surface for this guidance.

---

## TD-03: Environment verification

**Scope:** Backend

**Trigger:** How should "is my environment actually set up correctly" be verified, given it was repeatedly re-diagnosed by hand across sessions (Docker Desktop not running, `.env` gaps, a migration-cleanup bug, ESM-only packages silently breaking Jest)?

**Context:** `nestjs-project/CLAUDE.md` already documents individual verification commands (`docker compose ps`, `pg_isready`, `curl`), but nothing packages them into one command a session can run at the start of work, and nothing checks `.env` completeness against `.env.example` or migration status.

**Options:**

### Option A: A host-run shell script (`scripts/env-check.sh`) wrapping the existing documented commands
- One script: Docker daemon reachable → `.env` has every key from `.env.example` → every Compose service `running` → `db` accepting connections → informational pending-migrations check. Wrapped as `npm run env:check`.
- **Pros:** Reuses commands already documented in `nestjs-project/CLAUDE.md` as the host-only verification set — no new tooling dependency, no new command vocabulary for the team to learn. Fast (seconds).
- **Cons:** Host-only by nature (needs the `docker` CLI), which is an explicit, documented exception to the project's usual "everything runs in the container" rule — same class of exception `docker compose ps` and `curl http://localhost:3000` already are.

### Option B: A NestJS-integrated health-check module (e.g., `@nestjs/terminus`) exposed as `/health`
- Add a proper health-check endpoint to the running app itself.
- **Pros:** Reusable in production monitoring, not just local dev.
- **Cons:** Requires the app to already be running and compiled to answer — useless for exactly the failure mode this TD targets (Docker not running, `.env` missing, migrations not applied — states where the app can't start at all). Solves a different problem (runtime observability) than the one triggering this TD (pre-flight local setup verification).

### Option C: Status quo — documented commands, run manually, no script
- Keep relying on the individual commands already in `nestjs-project/CLAUDE.md`.
- **Pros:** No new file.
- **Cons:** This is the option that already failed — it's what produced the repeated from-scratch diagnosis across sessions that this TD exists to fix.

**Recommendation:** **Option A** — directly targets the observed failure mode (pre-app-start setup verification) using tooling already present, with Option B noted as complementary future work, not a substitute.

**Decision:** A (`scripts/env-check.sh`, host-only, wraps existing documented checks)

**Implementation note:** building this script surfaced a real, live bug — `.env.example` and `.env` both carry CRLF line endings (Windows checkout), which broke the script's own key-presence parsing (`read` picked up a trailing `\r` as part of each key name). Fixed by stripping `\r` before comparison, and a companion `.gitattributes` (`*.sh text eol=lf`) was added so the scripts themselves don't get CRLF-corrupted by a future checkout, which would reintroduce the same class of bug in the script rather than just its input.

---

## TD-04: Local runtime verification ("does the feature actually work")

**Scope:** Backend

**Trigger:** A real bug (`ffmpeg -ss 1` silently no-ops on sub-1-second videos) was found only because an integration test happened to exercise real ffmpeg — nothing systematically proves the running app works end-to-end. How should that gap close?

**Context:** The project's test pyramid (unit / integration / e2e, per `nestjs-project/CLAUDE.md` → "Test Type Selection") already exercises real DB and real HTTP via `supertest`, but all of it runs inside Jest against a test-configured app instance — never against the actual `docker compose`-run containers a user or agent would interact with. The retrospective also found the `video-worker` Compose service running the wrong start command, undetected for a whole phase, precisely because nothing hit the real running stack.

**Options:**

### Option A: A host-run shell script (`scripts/smoke-test.sh`) exercising the real running containers via `curl`
- Register → confirm-email (fetched from Mailpit's own REST API, token extracted from the real email) → login → authenticated request, all against `http://localhost:3000`. Auto-starts the dev server if the container is idling (its documented default). Wrapped as `npm run smoke`, with a marked extension point for phase-specific scenarios (e.g., a future video-upload flow) to be appended rather than spawning parallel scripts.
- **Pros:** Proves the actual deployed artifact works, not a Jest-instantiated stand-in — reuses the same Mailpit API (`src/test/mailpit.ts`) the project's own integration tests already rely on, so it's consistent with an established pattern rather than inventing a new one.
- **Cons:** Host-only (same class of exception as TD-03). First-run latency is real and environment-dependent — this repo's Windows bind-mount takes ~80s for a cold TS compile, which the script accounts for with a generous wait budget, but that number isn't portable to every machine.

### Option B: A Jest/Playwright-based "smoke" test file, run via `npm test`
- Write it as another Jest suite (or a lightweight Playwright/supertest scenario) alongside the existing e2e suite.
- **Pros:** Same tooling and command surface as the rest of the test pyramid; no new script language.
- **Cons:** Still runs through Jest's test-module bootstrap (`Test.createTestingModule()`), which is exactly the layer the retrospective shows already had a blind spot — the ffmpeg bug and the wrong `video-worker` Compose command were both invisible to that layer. A suite that boots its own app instance doesn't prove the actually-running container works; it would just be another integration test wearing a "smoke" label.

### Option C: Manual QA checklist, no automation
- Document steps for a human to click through.
- **Pros:** No script to maintain.
- **Cons:** This is the status quo that let the `video-worker` misconfiguration and the ffmpeg edge case ship unnoticed — manual, undocumented verification is precisely what this TD exists to replace with something repeatable and one-command.

**Recommendation:** **Option A** — the entire point is proving the real running system works, which by definition means bypassing the test-module bootstrap layer, not adding another suite inside it.

**Decision:** A (`scripts/smoke-test.sh`, host-run, real containers, extensible per phase)

---

## TD-05: Git-flow branch provenance enforcement

**Scope:** Repo-wide

**Trigger:** `main` ended up with a premature merge of partial phase-3 work (traced back through `git log --graph` earlier in this effort and fixed by resetting `main` to its fork-point commit) despite `CLAUDE.md` already stating the Git Flow rules in prose. How should the workflow actually enforce "dev must be up to date with main" and "branches come from dev, never from another feature branch or from main"?

**Context:** `implement-phase`'s existing Preflight already had a branch check, but it only verified the *current* branch wasn't `main`/`dev` — it never verified that `dev` itself was healthy (in sync with `main`) or that the current branch's fork point was a recent `dev`, not a stale one or a sibling feature branch. The retrospective also found a live, separate naming confusion (`dev` vs `develop` as two different branches) that this fix doesn't resolve on its own — see the Revision below.

**Options:**

### Option A: Extend `implement-phase` Preflight with `git merge-base` checks, backed by explicit `CLAUDE.md` prose rules
- Preflight runs `git fetch` then `git merge-base --is-ancestor origin/main origin/dev` (dev must contain everything main has) and compares the current branch's merge-base against `dev`'s tip. Stops and reports rather than auto-merging/rebasing on the user's behalf. `CLAUDE.md`'s Git Conventions section states the same rules in prose as the canonical reference for anyone (human or agent) working outside `implement-phase`.
- **Pros:** Runs automatically, inside the same tool that's already doing branch checks — no new dependency, no separate step to remember. Read-only (never mutates branches itself), matching the project's general caution around destructive git operations.
- **Cons:** Only enforced when `implement-phase` runs — a manual `git checkout -b` outside that skill isn't caught. Requires network access (`git fetch`) to be fully accurate.

### Option B: GitHub branch protection rules only (require PR review, restrict who can push to `main`)
- Configure protection at the GitHub repo level.
- **Pros:** Enforced server-side, can't be bypassed locally at all, including by a misconfigured agent.
- **Cons:** Doesn't stop a branch from being *cut* from a stale `dev` in the first place — the problem this TD targets is provenance at branch-creation time, not merge-time review. Requires repo-admin configuration outside this document's scope (no `.github/` workflows exist yet, per the earlier lint-strictness TD-07 revision that explicitly descoped CI bootstrapping as a separate task). Complementary to Option A, not a substitute.

### Option C: A local git pre-push hook
- Add a `.git/hooks/pre-push` (or a committed hook via a tool like `husky`) that blocks pushes violating the provenance rules.
- **Pros:** Catches violations regardless of which tool initiated the push.
- **Cons:** New tooling dependency (this project has no hook-management tool installed yet, and the lint-strictness TD-07 revision already deferred even an optional pre-push lint hook as separate scope). Less visible than a preflight check the agent already reports back to the user in-conversation.

**Recommendation:** **Option A**, with Option B noted as a legitimate complementary hardening step outside this document's scope (would need to be a separate task since it touches GitHub repo settings, not this repo's files).

**Decision:** A (`implement-phase` Preflight `merge-base` checks + `CLAUDE.md` prose rules)

---

## TD-06: Commit cadence enforcement

**Scope:** Repo-wide

**Trigger:** During phase-03-videos implementation, SI-1 through SI-4 were implemented with zero commits until the user manually interrupted with "create commits for each SI completed until now." `implement-phase/SKILL.md` explicitly stated "Git operations (add, commit, push, PR) are out of scope — the user owns version control." How should per-SI commit discipline actually be guaranteed?

**Context:** The plan document is already structured as discrete SIs, each with its own tests; the commit boundary the project wants (one commit per SI, made once tests+lint pass) maps exactly onto a boundary `implement-phase` already tracks (the per-SI loop's step 6 pause point). The gap wasn't a missing convention — `CLAUDE.md`'s Git Conventions already asked for "short, descriptive messages" — it was that no one, human or agent, was actually calling `git commit` at that boundary by default.

**Options:**

### Option A: `implement-phase` commits automatically at step 6, once the SI's tests and lint/format checks pass
- Stage and commit exactly that SI's changes (code + tests + progress-file update together) with the project's existing message convention, as part of the same step that already updates the progress file and pauses for confirmation. Pushing/opening a PR remain explicitly out of scope — only local commits are automated.
- **Pros:** Directly closes the observed gap — commits happen at the boundary where "this SI is done and verified" is already true, with zero extra user action required. Local-only (no push), so it stays reversible and doesn't touch anything outward-facing.
- **Cons:** Removes a manual checkpoint some users might have relied on to review a diff before it's committed (mitigated: commits are local, easily amended/reset before any push).

### Option B: Keep "git operations out of scope" — status quo, rely on the user to remember
- No change.
- **Pros:** Zero implementation cost.
- **Cons:** This is the option that already failed, observably, in the transcript this document is responding to.

### Option C: A git hook or CI check that blocks starting the next SI if the working tree has uncommitted changes
- Enforce the rule externally rather than having the agent perform the commit itself.
- **Pros:** Works even if a human runs the loop manually outside `implement-phase`.
- **Cons:** More moving parts for a project with no hook infrastructure yet (same gap noted in TD-05 Option C); `implement-phase` already has direct, safe git access and already performs the equivalent step for the progress file, so having it also commit is simpler than building an external gate for it to satisfy.

**Recommendation:** **Option A** — the agent already has the exact information needed (which files this SI touched, that its tests and lint are clean) at the moment it would otherwise just be pausing; committing then is strictly less work than building an external enforcement mechanism.

**Decision:** A (`implement-phase` step 6 auto-commits per SI, local-only)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Repo-wide | Repository Health Check scope/dispatch | Lightweight, advisory, `implement-phase`-only | A |
| TD-02 | Repo-wide | Deferred-debt tracking mechanism | `docs/known-issues.md` ledger | A |
| TD-03 | Backend | Environment verification | `scripts/env-check.sh` (host-run) | A |
| TD-04 | Backend | Local runtime verification | `scripts/smoke-test.sh` (host-run, real containers) | A |
| TD-05 | Repo-wide | Git-flow branch provenance enforcement | `implement-phase` Preflight `merge-base` checks | A |
| TD-06 | Repo-wide | Commit cadence enforcement | Auto-commit per SI at step 6, local-only | A |
