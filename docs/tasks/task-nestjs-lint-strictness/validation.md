---
kind: task
name: task-nestjs-lint-strictness
status: clean
issue_count: 0
sources_mtime:
  docs/tasks/task-nestjs-lint-strictness/context.md: "2026-08-28T13:42:42-03:00"
  docs/decisions/technical-decisions-nestjs-lint-strictness.md: "2026-08-28T13:40:22-03:00"
issues:
  - id: IC-1
    status: resolved
    summary: "TD-01=B (strictTypeChecked) undercuts TD-07=A's bounded single-PR rollout premise"
    resolved_by: nestjs-lint-strictness/TD-07
  - id: AMB-1
    status: resolved
    summary: "TD-02 leaves strictPropertyInitialization fork unresolved (entity ! vs carve-out)"
    resolved_by: clarification
  - id: MD-1
    status: resolved
    summary: "TD-07 CI lint gate has no CI pipeline to attach to — no .github/workflows exists"
    resolved_by: nestjs-lint-strictness/TD-07
advisories: []
---

# task-nestjs-lint-strictness — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._ _(task mode — DG-N does not apply.)_

### Inherited Constraint Conflicts

_None._ Re-checked all 7 current-scope TDs against the 6 inherited Phase 01 config conventions and the 9 inherited Phase 03 TDs. `strict: true` (TD-02) does not disturb the `@nestjs/config` / Joi / `data-source.ts` / `TypeOrmModule.forRootAsync` conventions. `strictTypeChecked` (TD-01) is an ESLint-layer change orthogonal to those conventions. The entity `!` additions (AMB-1 resolution) use the definite-assignment-assertion modifier on declarations, which `@typescript-eslint/no-non-null-assertion` does not flag.

### Unresolved Open Questions

_None._ All 7 TDs are `decided`; the decisions doc frontmatter reads `status: decided`.

### UI Coverage Gaps

_None._ _(no UI scope.)_

## Resolved Issues

- **IC-1** _(resolved_by nestjs-lint-strictness/TD-07)_ — TD-01 `**Decision:** B` (`strictTypeChecked`) reaffirmed by the user. A `**Revisions:**` entry on TD-07 (2026-08-28) records that the single-PR rollout now absorbs `strictTypeChecked`'s project-wide findings beyond the 504/16-file baseline, with the by-area split as fallback. Both TDs stay on B / A.
- **AMB-1** _(resolved_by clarification)_ — TD-02's `strictPropertyInitialization` fork resolved: add `!` (definite assignment assertion) to TypeORM entity column declarations. No carve-out; `strictPropertyInitialization` stays enabled under `"strict": true`. `/plan-build` specs the entity `!` additions under the TD-02 SI.
- **MD-1** _(resolved_by nestjs-lint-strictness/TD-07)_ — CI gap resolved by descoping. A `**Revisions:**` entry on TD-07 (2026-08-28) reduces the CI lint gate to local enforcement only (`lint:ci` script + optional pre-push hook); bootstrapping a CI pipeline is out of scope and tracked separately.
