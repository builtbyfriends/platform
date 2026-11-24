# Connected app runtime inspection — 2026-11-24

This is the initial publication receipt. The [later API-key redaction patch](./runtime-redaction-deploy-2026-11-24.md) records the current API version.

The installed API at `https://platform.buildwithfriends.dev` was patched to support read-only resource lists, file metadata, database table previews, and app activity through the connected application's credentials. The patch also backports group grants so a connected app can act for a team and record the acting person.

| Item                    | Verified value                                                     |
| ----------------------- | ------------------------------------------------------------------ |
| Worker                  | `platform-main-api`                                                |
| Installation            | `main-895b05ab5ed1`                                                |
| Full runtime baseline   | `192e281e5f8c745e2b2c4b6737f6ed0c7a5a27c0`, version `1.9.4`        |
| API patch source        | `8352672548c748bf88ce4f296f4e8687f5807bd0`                         |
| Active Worker version   | `1bd6a9cd-9943-49b5-b084-e1ccecae5c7e`                             |
| Active deployment       | `6582e095-827b-4fce-912f-d5d51f4f0e64`                             |
| Previous Worker version | `62972944-9dbd-488f-8cb1-de99eba264f7`                             |
| API bundle SHA-256      | `f0fbe9dd0afb0d0eb9cf5c479fa1471813e570f783c57572dc61bc4d47b8a3b6` |

The untouched baseline rebuild matched the downloaded live API bundle byte for byte. The patch was uploaded as an inactive version through the Workers Versions API. Its 63 bindings were inherited from the exact active version, including secrets. The deployment was checked before upload and again before activation. Health returned `200` after activation; resource, inspection, and activity calls without credentials returned `401`. Existing Worker settings and bindings matched the snapshot taken before publication.

This publication changed API code only. It did not run database migrations, change payer rules, update other Workers, or rewrite the installation manifest. The version annotation retains the existing trigger settings and omits the old code fingerprint. The beta API normalizes an unused default assets configuration to absent; this Worker has no assets binding. Existing asset resources and Worker-level settings were left in place.

The live-baseline branch is `codex/infra-runtime-live`. Do not merge this old-baseline branch into `main`. The forward implementation is on `codex/infra-runtime`, based on current `main`; upstream already contains the group grant behavior. Merge that forward implementation before the next normal installation upgrade, then build and upgrade with the usual installer. Otherwise, a normal deployment from unpatched source will replace these endpoints. The installer manifest still identifies the original full runtime, not a complete upgrade to the forward branch.

Validation: 19 focused runtime and group-grant tests passed on the live baseline, along with API typechecking and scoped lint. The forward branch passes 10 runtime tests and the product-name tests. The complete repository suite was not established as passing: earlier runs hit existing generated-playground configuration and unrelated test failures. No full-suite success is claimed.

Authenticated inspection of a real owned app through the connected client remains an end-to-end check. Aggregate hosted usage and group project listing are not part of this backport. App activity is scoped to a deployed app, not inferred as individual node or queued-job health. Storage browsing is read-only, and unsupported resource kinds return an explicit unavailable result.

To roll back this code-only API publication, use the recorded previous version with the existing account's Wrangler authentication:

```sh
pnpm exec wrangler rollback 62972944-9dbd-488f-8cb1-de99eba264f7 --name platform-main-api
```

Before rollback, read the active deployment and confirm it is still the version recorded above; a later deployment may contain other work.
