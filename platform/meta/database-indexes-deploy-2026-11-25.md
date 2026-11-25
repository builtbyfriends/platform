# Database indexes — 2026-11-25

The read-only database index action is live at https://platform.buildwithfriends.dev. A selected customer table can show its indexes through the generic bounded records result. The capability descriptor names the table-scoped Indexes view, so the app can use its selected table instead of asking for another table name.

| Item                    | Verified value                                                     |
| ----------------------- | ------------------------------------------------------------------ |
| Worker                  | `platform-main-api`                                                |
| Deployed source         | `ec84419190d49c4ec97303aa99e900d5385188a8`                         |
| Active Worker version   | `25e71594-d48c-4394-8e60-83f8b1139378`                             |
| Active deployment       | `82daf8fd-7c93-4aff-a48c-3459a90c9e2c`                             |
| Previous Worker version | `454805bb-8656-483a-a9c7-d87a83cb2461`                             |
| Previous deployment     | `3eb09220-e874-496c-a6ec-f842e597392c`                             |
| API bundle SHA-256      | `70a2204c6a08374bf858e9c5add971f928bec0e92302dfe283b0dfacb13d132c` |
| Bundle size             | 3,189,143 bytes                                                    |
| Verified at             | `2026-11-25T11:23:01.180Z`                                         |

Live code and settings matched the preceding [queue delivery receipt](./queue-delivery-deploy-2026-11-25.md) before upload. Upload and activation rechecked the exact deployment and settings. The candidate inherited all 63 bindings; runtime settings, exports, placement and bindings are preserved. Release annotations identify the new version. No SDK, proxy, tenant Worker, schema, customer data, plan, payer or installation changes were made.

After activation at 100%, the live module SHA-256 matched the checked artifact. Health passed. Unauthenticated resource inventory, inspection, execution and Activity requests returned 401. The compatible app release shipped first, as reported by its deployment owner: source `d9bff945`, version `01d4d2ec-c839-4801-a184-133745862faa`, deployment `2fd61cce-a866-400f-b938-1b81f47f24cf` at 100% on `2026-11-25T11:21:34.436271Z`, with deploy readiness and public health passing.

The action accepts only a table name from the resource's allowed customer tables. It returns names, uniqueness, ordered keys, origin and coverage through a fixed prepared metadata query. SQLite internal tables, migration tables and virtual shadow tables aren't inspected. Protected index names are omitted and mark the result incomplete; protected column names are masked. Expression text, partial-index SQL and default values aren't returned. Results cap indexes at 100, keys at 100 per index and text cells at 4096 characters, with a truncation marker when capped. The final owner, resource, proxy-token and active-deployment fence remains in place.

Current primary references: [D1 SQL statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/) documents index PRAGMAs and JSON support; [SQLite index metadata](https://www.sqlite.org/pragma.html#pragma_index_xinfo) documents key order, expression markers and auxiliary columns. The existing SDK binding handler and proxy already execute the prepared read; neither needed a change.

Validation: 117 focused integration tests pass on both forward and historical sources (65 queue and 52 existing/runtime tests including 13 new index cases), plus API typecheck, scoped lint, formatting and the API-only build. Tests execute actual local SQLite metadata queries and cover unique/compound/expression/partial indexes, quoted table names, protected names, bounded results, shadow tables, malformed metadata, strict inputs and ownership changes during reads. Historical production source matches forward `b5ad5c4`; its existing test owner-prefix literal is preserved. A full repository check wasn't run for this slice.

Native live-D1 acceptance passed through the production desktop app with the owner's signed-in account on 2026-11-25. The notes table returned its primary-key index, with unique enabled, the id column and full-table coverage. Refresh advanced checkedAt from 11:23:23.668Z to 11:23:42.687Z. The attachments table independently returned its primary-key index at 11:24Z. No page errors or writes occurred. Local screenshots: /tmp/field-notes-indexes-live.png and /tmp/field-notes-attachments-indexes-live.png. Changing tables resets the view to Data; the second-table check waited for that table to load before choosing Indexes. No index or app data was created, changed or deleted.

Forward source: `b5ad5c4` on `codex/infra-runtime`. Historical source: `ec84419` on `codex/infra-runtime-live`. Keep the forward change when upgrading; don't merge the historical branch into current main. Local snapshots, artifact and API receipts are under `.local/database-indexes/` in the historical worktree.

Rollback restores the preceding queue-delivery version after checking this deployment and its settings are still current:

Run from the historical worktree (`codex/infra-runtime-live`):

```sh
node .local/database-indexes/publish.mjs rollback
```

The previous version is retained. The rollback path has not been executed.
