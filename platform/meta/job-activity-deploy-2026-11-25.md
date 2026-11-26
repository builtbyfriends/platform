# Background job activity — 2026-11-25

The API-only Activity correction is live at https://platform.buildwithfriends.dev. Activity keeps log messages and exceptions from the exact queue and scheduled-task relay routes, including the existing fallback routes. Entries say “Background job” or “Scheduled task” without exposing internal relay addresses. Other platform control requests stay hidden; similar paths on customer domains remain visible.

| Item                    | Verified value                                                     |
| ----------------------- | ------------------------------------------------------------------ |
| Worker                  | `platform-main-api`                                                |
| Deployed source         | `72bda7a306d3a065b0250e7b81c931742cd78aa8`                         |
| Active Worker version   | `168667c7-b9bc-4695-ba6f-b7f977bad416`                             |
| Active deployment       | `7726e418-d091-4e2c-894b-fb446acd9ef3`                             |
| Previous Worker version | `4b6d6197-2c9d-4bee-a423-7c6b771296d6`                             |
| Previous deployment     | `ff2ac659-dcee-484a-a765-c36eaf3108fc`                             |
| API bundle SHA-256      | `83b2b5b6d0bc69c0fe1808e13c6d656e7128d6ecba54ad8598fbd5f2150fe019` |
| Verified at             | `2026-11-25T09:10:47.551Z`                                         |

The live code and settings matched the preceding [resource-actions receipt](./resource-actions-deploy-2026-11-25.md) before upload. The candidate inherited all 63 bindings from that exact version. The build differs only in the Activity request classifier and event mapping; the surrounding bundle matches byte for byte. No schema, proxy, tenant Worker, data, plan, payer or installation changes were made.

Upload changed script-settings annotations to the candidate’s exact annotation set while the preceding version remained active. The guard stopped, this delta was checked, and the guard then required that specific annotation set along with unchanged runtime settings. Activation rechecked the live deployment, settings and health. Afterwards, health passed, all 63 bindings and runtime settings matched, and unauthenticated `projects.resources`, `resources.inspect`, `resources.execute` and `projects.activity` calls returned 401.

Validation: 31 runtime integration tests pass on the identical forward API source, including relay errors, hidden controls, customer-domain paths, owner rejection and an ownership change during a log read. API typecheck, scoped lint and formatting pass. The API-only artifact builds. A full repository check was blocked by an unrelated missing generated playground configuration; no full-suite result is claimed. This receipt does not claim a live customer queue or scheduled task was run. Activity remains app-scoped; it adds no per-node health, backlog or job controls.

Forward implementation: `2b70990` on `codex/infra-runtime`. Historical backport: `72bda7a` on `codex/infra-runtime-live`. Keep the forward change when upgrading the installation; do not merge the historical branch into current main. Local snapshots, artifact and API receipts are under `.local/job-activity/` in the historical worktree.

Rollback restores the previous API version after checking that this deployment and its settings are still current:

From the historical `platform-runtime-live` worktree:

```sh
node .local/job-activity/publish.mjs rollback
```

The previous version is retained. The rollback path has not been executed.
