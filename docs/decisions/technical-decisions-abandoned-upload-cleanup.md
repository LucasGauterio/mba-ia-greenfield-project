---
scope_type: ad-hoc
related_phases: [3]
status: decided
date: 2026-08-31
scope_description: "What happens to a video whose upload was started (draft row + open S3 multipart) but never completed: TTL sweep, multipart abort, terminal state."
---

# Technical Decisions — Abandoned / Never-Completed Upload Cleanup

_Subprojects in scope:_

- `nestjs-project/` — backend; adds a scheduled sweep job to the video processing infrastructure. No frontend surface.

> **Why this document exists.** Phase 03's main decisions (`technical-decisions-phase-03-videos.md`) cover the happy path and processing failures, but not the case where a client calls `POST /videos` (creating a `draft` row and an S3 `CreateMultipartUpload`) and then never calls `POST /videos/:id/complete-upload`. Left alone, the row sits in `draft` forever and the open multipart keeps its uploaded parts billable/consuming storage indefinitely. `plan-validate` raises this as **`MD-1`**. Per `PLAN.md` §11.7 the prior execution closed it with this dedicated ad-hoc TD rather than widening `phase-03-videos/TD-08`; this document does the same.

---

## TD-01: Cleanup strategy for abandoned uploads

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Trigger:** An upload can be initiated (`POST /videos` → `draft` row + open S3 multipart with a persisted `upload_id`) and never completed — the client crashes, abandons the tab, or loses connectivity permanently. Nothing in the phase-03 happy path or failure path reclaims that row or aborts that multipart.

**Context:** The `videos` table (phase-03 Data Model) has `status`, `created_at`, and a persisted `upload_id` (from `CreateMultipartUpload`, TD-02/TD-03). The queue chosen in `phase-03-videos/TD-01` is **pg-boss**, which offers a native `schedule()` cron with timezone support. S3/MinIO exposes `AbortMultipartUpload` to discard an incomplete multipart and its parts.

**Options:**

### Option A: Scheduled TTL sweep + explicit `AbortMultipartUpload`
- A pg-boss `schedule()` cron job (hourly, `0 * * * *`) selects `videos WHERE status = 'draft' AND created_at < now() - interval '24 hours'`, calls `AbortMultipartUpload(bucket, key, upload_id)` for each, and flips the row to `status = 'error'` with `error_reason = 'upload_abandoned_ttl_exceeded'`. TTL (24h) and cadence are named constants.
- **Pros:** Reuses the queue already in the stack — no new dependency, no new container; `AbortMultipartUpload` is the S3-sanctioned way to release incomplete-multipart storage immediately (does not wait on a bucket lifecycle rule); the terminal `error` state is consistent with `phase-03-videos/TD-08`, and `error_reason` distinguishes it from a processing failure; deterministic and unit/integration-testable (seed an old `draft`, run the handler, assert the abort call + status).
- **Cons:** A fixed TTL is a policy guess — a very slow legitimate upload could in principle exceed 24h (mitigated: 24h is generous for a 10GB multipart; the client can restart); requires the sweep handler to tolerate an already-aborted or already-completed multipart (idempotency).

### Option B: S3 bucket lifecycle rule for incomplete multipart uploads only
- Configure MinIO/S3 with `AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 }`; leave the `draft` rows to a separate concern.
- **Pros:** Zero application code for the storage side; storage reclaims the parts on its own schedule.
- **Cons:** Only cleans **storage** — the `draft` DB row still sits forever, so `MD-1`'s "draft preso em `draft` para sempre" half is unsolved; lifecycle granularity is whole-days and enforcement timing is not guaranteed-prompt; the rule must be reproduced in every environment's storage config (Compose `minio-init` + prod S3) as out-of-band infra.

### Option C: Reap lazily on read / on next upload
- When a video is read or when the same channel starts a new upload, opportunistically expire stale `draft` rows.
- **Pros:** No scheduler at all.
- **Cons:** Unbounded latency — a `draft` nobody ever touches again is never cleaned; scatters the TTL rule across unrelated request paths; the multipart abort still needs to happen somewhere.

**Recommendation:** **Option A** — a pg-boss scheduled sweep is the only option that reclaims **both** the DB row and the storage parts, uses infrastructure already chosen for the phase, keeps the TTL policy in one place, and is straightforwardly testable. A storage lifecycle rule (Option B) is a fine belt-and-suspenders addition later but does not close the DB half of `MD-1`.

**Decision:** A (hourly pg-boss `schedule('0 * * * *')` sweep of `draft` rows older than 24h → `AbortMultipartUpload` with the persisted `upload_id` → `status = 'error'`, `error_reason = 'upload_abandoned_ttl_exceeded'`; TTL and cadence as named constants; handler idempotent against an already-closed multipart).
**Libraries:** `pg-boss@^10`, `@aws-sdk/client-s3@^3`

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Cleanup of abandoned/never-completed uploads | Scheduled TTL sweep + `AbortMultipartUpload` | A (pg-boss cron sweep) |

---

## Notes for the planning pipeline

- Libraries: no new ones beyond `phase-03-videos` — reuses `pg-boss` (`schedule()`) and `@aws-sdk/client-s3` (`AbortMultipartUpload`).
- Closes `plan-validate` issue **`MD-1`**. Reference form from other docs: `abandoned-upload-cleanup/TD-01`.
- Depends on the phase-03 Data Model persisting `upload_id` and `created_at` on `videos`, and on `phase-03-videos/TD-01` (pg-boss) and `TD-08` (the `error` state + `error_reason`).
