# Customer database tables — 2026-11-24

The API-only follow-up to [private preview inspection](./preview-inspection-deploy-2026-11-24.md) is live at https://platform.buildwithfriends.dev. The app data browser hides known migration bookkeeping tables and refuses direct reads of them. Names are matched exactly, without excluding customer tables that share a prefix.

Hidden names: `_void_migrations`, `_void_migration_attempts`, `_void_migration_fences`, `_void_migration_lock`, `_migrations`, and `__drizzle_migrations`. The existing database-engine table filter remains in place.

| Item                    | Verified value                                                     |
| ----------------------- | ------------------------------------------------------------------ |
| Worker                  | `platform-main-api`                                                |
| Deployed source         | `50b0008d4dcb56b7fa18053e733394d934adb5fd`                         |
| Active Worker version   | `61c968ca-3288-4fb2-9345-b81fcb671fb8`                             |
| Active deployment       | `4f142d39-01c5-4f1b-acf8-556fb107d5ce`                             |
| Previous Worker version | `9b12bf40-a302-468a-ad0d-2fa6b64e264f`                             |
| Previous deployment     | `aee7df70-bfb1-42e9-9a9b-e3edaeba9fb3`                             |
| API bundle SHA-256      | `246d0395361bea03c25566d5c7ad501e686db81c5a6e4c12b25d5f8310630bfc` |

The downloaded baseline matched the previous receipt. Activation checked the previous deployment again. All 63 bindings and Worker settings were preserved. Health passed; unauthenticated resource, inspection and activity calls returned 401. No data, schema, plan, payer, permissions or other Worker changes were made.

Validation: 14 runtime integration tests pass on both branches. Real SQLite tests show that notes, attachments and similarly named customer tables stay readable, while the known managed tables are hidden and direct requests return 400. API typechecks, scoped lint and the historical runtime bundle build pass. The signed-in customer inspector refresh is a separate app check.

Forward source is `50400e4` on `codex/infra-runtime`; deployed source is `50b0008` on `codex/infra-runtime-live`. This continues the historical API-only patch lineage from baseline `192e281e5f8c745e2b2c4b6737f6ed0c7a5a27c0`. Merge the forward branch before a normal installation upgrade to retain these changes. The historical branch was not merged with current main.
