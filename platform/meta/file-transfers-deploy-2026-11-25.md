# File transfer API deployment — 2026-11-25

The API-only maintenance patch is live. Uploads create files up to 5 MiB without replacing an existing key; downloads stream the original bytes. Existing app deployments must support the conditional storage operation. Unsupported deployments return unavailable.

| Evidence | Value |
| --- | --- |
| Source | `b8b71c7f989ac47b50026fd8606c49d97123ca17` |
| Worker | `platform-main-api` |
| Version | `7165bed6-9282-4e15-8a8b-243bf30056fc` |
| Deployment | `36985f43-909c-4de8-87ee-934747b3acd8` |
| Verified | 2026-11-25T12:55:00.769Z |
| Artifact SHA-256 | `7aa0af2c4b0082e533204d716ae14ce71480a7db7cec940217a00d82f4c26b37` |
| Previous version | `25e71594-d48c-4394-8e60-83f8b1139378` |
| Previous deployment | `82daf8fd-7c93-4aff-a48c-3459a90c9e2c` |

The active code matches the built artifact. Health passed. The existing 63 bindings and Worker settings are unchanged. Unauthenticated inventory, inspection, action, activity, file download and file upload requests each returned 401. No customer files were changed during deployment verification.

The maintenance source passed 39 file-transfer and 52 existing runtime integration tests, API typecheck, scoped lint and diff checks. The forward port also passed its additional project-suspension case and 51 Vectorize regressions; the compatible release candidate passed the same suites without the forward-only schema field. The forward port retains its newer project suspension check. SDK, proxy behavior, schema and installation capabilities are unchanged by this patch. This deployment does not enable Vectorize or publish packages.

Local build and deployment evidence is retained under `.local/file-transfers/` in the `codex/infra-file-transfers` worktree. To roll back this maintenance deployment, run from that worktree:

```sh
node .local/file-transfers/publish.mjs rollback
```

The rollback helper checks the current version before restoring the recorded previous version. Customer-facing upload and download acceptance is tracked separately from these deployment checks.
