---
scope_type: ad-hoc
related_phases: [3]
status: pending
date: 2026-08-25
scope_description: "Cleanup policy for videos whose multipart upload is abandoned or never completed — closes MD-1 raised by plan-validate on phase-03-videos (draft row stuck forever + orphaned S3/MinIO multipart upload)."
---

# Technical Decisions — Abandoned Video Upload Cleanup Policy

_Subprojects in scope:_

- `nestjs-project/` — owns the sweep mechanism (if any), the video status transition applied to abandoned drafts, and the object-storage-side cleanup of the orphaned multipart upload.
- `next-frontend/` — no open decision in this document. Video UI is out of scope for Phase 03 entirely (per `phase-03-videos` decisions doc); this document does not add any FE-facing capability.

---

## TD-01: Abandoned/Never-Completed Upload Cleanup Mechanism

**Scope:** Backend

**Trigger:** `plan-validate` raised MD-1 on `phase-03-videos`: TD-02 (S3-compatible multipart upload, direct client-to-storage) lets a client create a multipart upload — and the draft video row per capability "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload" — and then never call the completion endpoint (TD-03), or abandon the transfer partway. TD-08's status lifecycle (`draft → processing → ready | error`) only defines the failure path for *processing* failures after a successful upload; nothing addresses a video stuck in `draft` forever, nor the abandoned S3/MinIO multipart upload left accumulating storage cost on the object-storage side. `docs/project-plan.md` §4 ("Pontos de Atenção") separately flags storage cost/growth as a first-class concern for this project ("vídeos grandes consomem muito espaço... planejar o crescimento e os custos de armazenamento desde o início").

**Context:** Two independent leaks need closing, both a consequence of `phase-03-videos/TD-02`'s already-decided direct-to-storage multipart strategy:

1. **DB-side:** a `videos` row stuck at `status = 'draft'` indefinitely — clutters listings, has no terminal state.
2. **Storage-side:** an S3/MinIO multipart upload that was started (`CreateMultipartUpload`) but never finished (`CompleteMultipartUpload`) — the parts already uploaded stay billed/stored until explicitly aborted, even though the object never becomes visible.

This decision depends on `phase-03-videos/TD-01` (queue technology — pg-boss, decided) for any scheduled-job mechanism, and constrains how `phase-03-videos/TD-08`'s status enum is used (whether abandonment reuses the existing `error` state or needs a distinct terminal state).

**Options:**

### Option A: Scheduled sweep job (pg-boss `schedule()`) + explicit `AbortMultipartUpload`

A pg-boss cron-scheduled job (`boss.schedule('cleanup-abandoned-uploads', '0 * * * *', ...)` — pg-boss supports native cron scheduling via `schedule(name, cron, data, options)`, confirmed against the installed queue tech from `phase-03-videos/TD-01`) runs hourly. It queries `videos` rows where `status = 'draft'` and `createdAt` is older than a TTL (e.g., 24h), and for each: calls the storage client's `AbortMultipartUpload` using the `uploadId` already persisted on the draft row (needed anyway for `TD-03`'s completion flow), then updates the row to `status = 'error'` with an error reason (`upload_abandoned_ttl_exceeded`) — reusing `phase-03-videos/TD-08`'s existing terminal state, no new status value.

- **Pros:** Fixes both leaks (DB row + storage cost) in one deterministic, testable mechanism. Reuses infrastructure already decided (`TD-01` pg-boss scheduling, `TD-08` `error` status, the `uploadId` column already needed by `TD-03`) — no new dependency. Directly integration-testable against the real Compose stack (real Postgres + real MinIO), matching the project's testing conventions (no mocking what Compose can run for real).
- **Cons:** One new scheduled job + handler to write and test. TTL value is a policy choice that must be picked (see Notes below — deferred to `implement` as a config value, not a second TD).

### Option B: Storage-side lifecycle rule only (MinIO/S3 `AbortIncompleteMultipartUpload`)

Configure the video bucket's lifecycle policy with an `AbortIncompleteMultipartUpload` rule (`DaysAfterInitiation: N`) — a native S3 API feature MinIO also implements, since MinIO exposes the same S3-compatible bucket lifecycle API `phase-03-videos/TD-04` already relies on. Storage auto-aborts stale multipart uploads; no application code runs.

- **Pros:** Zero custom code — pure bucket configuration (one block in the MinIO bootstrap/compose setup). No new job, no new queue traffic.
- **Cons:** Only fixes the storage-side leak. The `videos` row stays `draft` forever — nothing ever flips its status, so it keeps showing up in any future "my videos" listing (Phase 04) as a permanently-incomplete draft with no explanation. Silent from the application's point of view: there's no event/callback when the lifecycle rule fires, so the DB and storage state can drift out of sync (row says `draft`, object no longer has any parts).

### Option C: No cleanup this phase — explicit accepted risk

Do not implement any sweep or lifecycle rule. Document the gap as an accepted, deferred risk for a future phase (e.g., a Phase 04+ admin/cleanup task).

- **Pros:** Zero implementation cost this phase.
- **Cons:** Directly contradicts `docs/project-plan.md`'s explicit storage-cost concern. Silently accumulates both DB clutter and real storage billing for every abandoned upload, with no bound — for a course project this is a minor risk, but it is the one option that does nothing to address a capability-adjacent concern the project plan calls out by name.

**Recommendation:** **Option A (scheduled sweep job + explicit `AbortMultipartUpload`)** — it is the only option that closes both leaks (DB row and storage cost) using infrastructure already decided in this phase (pg-boss scheduling from `TD-01`, the `error` status from `TD-08`, the `uploadId` column already needed by `TD-03`), with no new dependency and a mechanism directly testable against the real Compose stack. Option B alone leaves the DB-side leak open and introduces a silent drift between storage and DB state. Option C is rejected given the project plan's explicit storage-cost concern — closing this gap costs one scheduled job, not a new subsystem.

**Note (deferred to `implement`, not a second TD):** the exact TTL value (e.g., 24h) and the cron cadence (e.g., hourly) are bounded configuration choices with no competing strategic trade-off — `implement` picks sensible defaults (or a config-driven value) following this TD's mechanism, per the research skill's own implementation-detail exclusion.

**Decision:** A (Scheduled sweep job via pg-boss `schedule()` + explicit `AbortMultipartUpload`)

**Libraries:** pg-boss, @aws-sdk/client-s3

**Revisions:**
- 2026-08-25 — Clarified this TD (not phase-03-videos/TD-08) owns abandoned/never-completed upload handling. Rationale: user initially asked to extend TD-08 for this concern; /decide triage confirmed TD-01 here (created via /research to close plan-validate's MD-1) is the correct owner — TD-08's status lifecycle stays scoped to post-upload processing failures only, avoiding duplicate/conflicting decisions across two TDs.

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Abandoned/Never-Completed Upload Cleanup Mechanism | A (Scheduled sweep job via pg-boss `schedule()` + explicit `AbortMultipartUpload`) | A (Scheduled sweep job via pg-boss `schedule()` + explicit `AbortMultipartUpload`) |
