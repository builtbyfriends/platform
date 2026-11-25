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

## Corrected deployment

Native acceptance after the initial deployment found that authenticated transfers failed before storage: Workers rejects the Node-supported `redirect: 'error'` option. The test file was confirmed absent before a retry. Initial health and authorization probes were valid but did not prove a successful file transfer.

The replacement uses `manual` for both service-binding requests and keeps non-success response rejection. A local workerd probe reproduced the original error and verified the corrected request. The maintenance checks passed 43 transfer and 52 runtime tests, API typecheck and lint. Four new cases cover both methods and refusal to follow redirect responses.

| Replacement evidence | Value |
| --- | --- |
| Source | `e8acb7a13e72db1bb3f36916a30bce9d970fe0f7` |
| Version | `89bdc95b-519d-4b0f-b875-922cf5f766f6` |
| Deployment | `b1e28c79-0515-4352-bebf-ca7250e7cb08` |
| Verified | 2026-11-25T13:17:40.650Z |
| Artifact SHA-256 | `16f9fbeeaf0e9e39c0e7a3ed3e4b308b7a31dcbe2441dbe82968b45437e975b4` |

Exact live code, health, 63 unchanged bindings/settings and all six unauthenticated-route rejections were checked again. Native customer transfer acceptance is separate. Local replacement evidence is in `.local/file-transfers-redirect/`. Its rollback helper restores the initial file-transfer version, which has this known runtime defect; use that rollback only with awareness that transfers will stop working.
