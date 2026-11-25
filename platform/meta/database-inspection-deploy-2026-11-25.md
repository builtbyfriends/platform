# Database inspection — 2026-11-25

The API-only database inspection update is live at https://platform.buildwithfriends.dev. Database resources advertise structure, filtering and sorting capabilities. Structure returns column names, declared types, declared Not null constraints and primary-key order. It excludes defaults and expressions. Credential columns stay redacted and can't be used for filtering or sorting.

| Item                    | Verified value                                                     |
| ----------------------- | ------------------------------------------------------------------ |
| Worker                  | `platform-main-api`                                                |
| Deployed source         | `c3f4f6f28d53b9fd18b686e3f4c6263ec2bcfa0c`                         |
| Active Worker version   | `83dcdae6-0253-49f5-9fc8-3d22a4f60c21`                             |
| Active deployment       | `cfa78272-e0c0-4036-a66d-e80ca4ad0e7e`                             |
| Previous Worker version | `168667c7-b9bc-4695-ba6f-b7f977bad416`                             |
| Previous deployment     | `7726e418-d091-4e2c-894b-fb446acd9ef3`                             |
| API bundle SHA-256      | `7d7d5add0647de156d37056ea6a9a72266fde94a103cdf8a0bde01e8b6d4c5a2` |
| Bundle size             | 3,181,300 bytes                                                    |
| Verified at             | `2026-11-25T09:39:33.141Z`                                         |

The deployed code, version and settings matched the preceding [Activity receipt](./job-activity-deploy-2026-11-25.md) before upload. The candidate inherited all 63 bindings from that version. The upload and activation guards rechecked the exact active deployment and settings. Runtime settings, exports, placement and bindings are preserved; release annotations identify the new version. No proxy, tenant Worker, schema, data, plan, payer or installation changes were made.

After activation at 100%, the live module's SHA-256 matched the checked artifact. Health passed. Unauthenticated resource inventory, inspection, execution and Activity requests returned 401. These checks establish deployment integrity and access rejection, not an authenticated customer's successful database inspection in the app; that app check is separate.

The compatible app parser shipped first, as reported by the app deployment owner: source `507a90c6`, Worker version `4d1b50d8-8b92-4ba7-9dc0-fe8239b819ad`, deployment `942cdd19-6a49-4acb-b318-667c0998a873` at 100%. The query-clear request metadata correction is app-side only.

Validation: 39 focused runtime integration tests, API typecheck, scoped lint, formatting and the API-only build pass on the historical backport. Tests include SQLite schema semantics, generated-column redaction, literal and parameterized filters, stable pagination with repeated sort values, page limits, credential-inference rejection and ownership/binding-change fences. The production API source matches forward commit `5544c66475733f75379800d387395339b05cc706`; only the historical test fixture retains its prior owner-prefix literal. A full repository check wasn't run for this slice. Minifier identifiers changed across the bundle, so this receipt makes no claim that surrounding bundle bytes are unchanged.

Reads are limited to 50 rows per page, offsets through 10,000, 100 columns and bounded cell/response sizes. The response echoes the applied filter and sort, and signals when more rows exist beyond the inspection cap. Contains is a case-sensitive literal substring search. Tables without a safe non-secret unique row order reject filtered or sorted pagination. This adds no arbitrary SQL or database writes.

Forward source: `5544c66` on `codex/infra-runtime`. Historical source: `c3f4f6f` on `codex/infra-runtime-live`. Keep the forward change when upgrading; don't merge the historical branch into current main. Local snapshots, artifact and API receipts are under `.local/database-query/` in the historical worktree.

Rollback restores the preceding Activity version after checking that this deployment and its settings are still current:

```sh
cd /home/joe/Projects/dedworc/.worktrees/platform-runtime-live && node .local/database-query/publish.mjs rollback
```

The previous version is retained. The rollback path has not been executed.
