# KV editor API deployment — 2026-11-25

The API-only maintenance patch is live. It adds reviewed text-key creation and replacement, preserves private metadata, and supports preserving, changing or removing expiration. Values are limited to 64 KiB. Protected values cannot be edited. KV writes remain eventually consistent and last-write-wins: the fingerprint check detects observed changes but is not an atomic lock. A successful response means the provider accepted the write, not that reads have converged.

| Evidence | Value |
| --- | --- |
| Source | `59e1358d6f7741636e313301d2937532517c5a16` |
| Worker | `platform-main-api` |
| Version | `09443e2a-d8f2-48c4-b6c5-ba7f3bf95999` |
| Deployment | `3bec7de6-fcde-44d1-96b6-33d565ff0600` |
| Verified | 2026-11-25T13:47:46.087Z |
| Artifact SHA-256 | `457850047583a06ce9c7d39b3452cc342d3efea8595f80584f438e2b6cfe2c9a` |
| Previous version | `89bdc95b-519d-4b0f-b875-922cf5f766f6` |
| Previous deployment | `b1e28c79-0515-4352-bebf-ca7250e7cb08` |

The live code matches the reviewed artifact. Health passed; the existing 63 bindings and Worker settings are unchanged. Unauthenticated inventory, inspection, action, activity, file download and file upload requests each returned 401. No customer KV writes or live customer KV acceptance tests were performed during these deployment checks.

Before deployment, the maintenance source passed 51 KV and 52 existing runtime integration tests, API typecheck and scoped lint. A local workerd probe checked exact UTF-8 multipart bytes, metadata and absolute expiry. The forward port passed 155 focused tests, including its project-suspension regression; the compatible release candidate passed 154. No SDK, proxy, schema, billing or installation-capability changes are included. Vectorize remains outside this deployment.

Local evidence is retained under `.local/kv-editor-deploy/` in the `codex/infra-file-transfers` worktree. To restore the recorded previous version, run from that worktree:

```sh
node .local/kv-editor-deploy/publish.mjs rollback
```

The helper checks the active version before rollback. Live customer acceptance is separate from this deployment receipt.
