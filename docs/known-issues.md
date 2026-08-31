# Known Issues Ledger

Tracked, time-boxed exceptions to Definition-of-Done gates (lint, `tsc`, tests,
environment health). This is the **only** sanctioned way to defer a
pre-existing problem when starting new work — see `CLAUDE.md` → "Environment
& Phase Health" and `.claude/rules/typescript-strict.md`.

**Never** silence a whole rule/category in `eslint.config.mjs` or `tsconfig.json`
to make this ledger unnecessary. Scope the exception to the exact files
listed below, link a follow-up, and remove the entry (moving it to
`## RESOLVED`) the moment it's fixed.

## OPEN

_None currently open._

<!--
### KI-N — <short title>
- **Origin phase:** phase-NN-{slug} | task-{slug}
- **Files/rule:** <glob or explicit file list> / <eslint rule id or tsc flag>
- **Reason it wasn't fixed inline:** <why — e.g. "pre-existing, unrelated to this phase's scope">
- **Follow-up:** <task/phase slug that will close it, or "none yet — needs one">
- **Opened:** <YYYY-MM-DD>
-->

## RESOLVED

_None yet._

<!--
### KI-N — <short title> — RESOLVED
- **Resolved by:** <commit sha or PR link>
- **Resolved on:** <YYYY-MM-DD>
-->
