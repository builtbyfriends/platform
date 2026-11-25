# Activity ranges API deployment — 2026-11-25

The API-only maintenance patch is live. Activity supports one-hour, 24-hour and seven-day captured windows for the current deployment. Older and Newer pages keep the original window. Responses include the applied range, deployment, actual queried bounds and observation time. This does not promise retained logs, complete logging or resource-specific traces.

| Evidence            | Value                                                              |
| ------------------- | ------------------------------------------------------------------ |
| Source              | `9834e8b2aa810d0fbdcf82b0d24cd53a504fc67a`                         |
| Worker              | `platform-main-api`                                                |
| Version             | `ea914984-f326-4678-98cc-af0a631554be`                             |
| Deployment          | `0e8fe7f3-cd4f-455e-8b98-81a173a0a742`                             |
| Verified            | 2026-11-25T14:21:25.477Z                                           |
| Artifact SHA-256    | `f4c99726f4ecfbbef5c37954822ec5f6087cbaf34e88220f92b2536e044dde83` |
| Previous version    | `09443e2a-d8f2-48c4-b6c5-ba7f3bf95999`                             |
| Previous deployment | `3bec7de6-fcde-44d1-96b6-33d565ff0600`                             |

The live code matches the reviewed artifact. Health passed; the existing 63 bindings and Worker settings are unchanged. Unauthenticated inventory, inspection, action, activity, file download and file upload requests each returned 401. No customer data was changed. Native customer Activity acceptance is separate from these deployment checks.

The maintenance source passed 70 runtime integration tests, API typecheck and scoped lint. The unchanged operator checks passed 57 tests with two existing skips. Coverage includes range and deployment cursor validation, fixed-window navigation, unavailable metadata, owner suspension before and after reads, and a read crossing a clock boundary. Successful receipts are timestamped after the read and final access check. The forward port passed 71 runtime tests, including its project-suspension check; the compatible candidate passed 70. No SDK, proxy, schema, billing or installation-capability changes are included.

Local evidence is retained under `.local/activity-ranges/` in the `codex/infra-file-transfers` worktree. To restore the recorded previous version, run from that worktree:

```sh
node .local/activity-ranges/publish.mjs rollback
```

The helper checks the active version before rollback. The compatible runtime candidate's older coordinated build remains marked stale and needs a rebuild before use; this API deployment does not release or enable Vectorize.
