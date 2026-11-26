# Provider schema API deployment — 2026-11-26

The approved API version is live. It adds full pinned operation-schema retrieval, exact-resource catalog execution hints, bounded provider metadata reads, read-only database queries and observed deployment bindings.

| Evidence | Value |
| --- | --- |
| Source | `0088fc8a17515d96cbb0807db1d4372df349714f` |
| Worker | `platform-main-api` |
| Version | `92cdf550-6ef4-49f4-aac6-283c955aef97` |
| Deployment | `4416d3dd-f383-458c-8bd0-d93352450ffa` |
| Verified | `2026-11-26T02:25:53.360Z` |
| Artifact SHA-256 | `1da6e51a8b41069944ac87a4fa1f21ebbc529155f323518e5c9ff4d12a8d3e7e` |
| Previous version | `5d6ef97d-dda1-43c1-954f-435e879a1c84` |

The active version's code matches the checked artifact. All 63 bindings and version configuration are preserved; no migrations ran. Health passed. Unauthenticated requests to the capability catalog, resource operations, invocation, inventory, inspection and execution routes returned 401. Authenticated customer acceptance remains separate.

All 3,944 complete pinned schema artifacts were published to the installation's existing assets bucket. Inventory sizes and ETags match, and eight content readbacks passed digest and bounded decompression checks. Four upstream operations with undefined security schemes remain excluded. Full schemas are discovery information; they do not grant execution. Provider metadata execution currently covers owned D1, R2, KV and Queue resources only.

Verification: 20 workspace typechecks passed. The full affected run had 705 passing files, 11 failing files and one skipped file. Diagnosed reporter, local dependency-resolution and Workerd module-root failures were corrected; all originally failing files then passed focused checks (96 tests). The full suite was not repeated. A local Workerd probe loaded the four provider schemas from R2 and constructed matching cold/warm operation descriptors. A full API local probe could not complete without the installation database; it is not recorded as a passing health or authorization test.

Durable local receipts are in `.local-runtime/provider-candidate/` and `.local-runtime/cloudflare-openapi/` in the `codex/readonly-database-query` worktree. The activation helper accepts only the approved version, fences the baseline before changing traffic, and verifies the active version afterward. To recover, inspect the current deployment first and restore the recorded previous version if it is still the appropriate baseline; do not roll back over another deployment.
