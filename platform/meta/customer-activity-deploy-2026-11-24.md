# Customer runtime activity — 2026-11-24

The API-only follow-up to [customer database tables](./customer-tables-deploy-2026-11-24.md) is live at https://platform.buildwithfriends.dev. Activity excludes control requests only when the URL hostname is exactly `worker` or `internal` and the path is `/__platform` or beneath it. Customer-host requests remain visible, including requests with the same path. HTTP 4xx responses show as warnings; HTTP 5xx, exceptions and error logs show as errors. HTTP failure summaries include the response status.

| Item                    | Verified value                                                     |
| ----------------------- | ------------------------------------------------------------------ |
| Worker                  | `platform-main-api`                                                |
| Deployed source         | `4afb240a03f277da8d499c16365ff92b9c714ca1`                         |
| Active Worker version   | `e2ff5f2e-a4a4-4772-999f-acc9a716a6e2`                             |
| Active deployment       | `293bd382-4e93-4eba-848a-c17da2cf7dc8`                             |
| Previous Worker version | `61c968ca-3288-4fb2-9345-b81fcb671fb8`                             |
| Previous deployment     | `4f142d39-01c5-4f1b-acf8-556fb107d5ce`                             |
| API bundle SHA-256      | `fa369650952be93ef19385e10eb95354986e92a232ac231046fae39caedf90af` |

The downloaded baseline matched the previous receipt; activation checked the previous deployment again. All 63 bindings and Worker settings were preserved. Health passed and unauthenticated resource, inspection and activity calls each returned 401. No data, schema, plan, payer, permission or other Worker changes were made.

Validation: 15 runtime integration tests pass on each branch, including exact host/path filtering, retained customer traffic and HTTP/exception severity. Both API typechecks and scoped lint pass, and the historical runtime bundle builds. A signed-in Activity refresh is a separate app check. Filtered pages retain the existing cursor, so more history can still be loaded.

Forward source is `f004093` on `codex/infra-runtime`; deployed source is `4afb240` on `codex/infra-runtime-live`. This continues the historical API-only patch lineage from baseline `192e281e5f8c745e2b2c4b6737f6ed0c7a5a27c0`. Merge the forward branch before a normal installation upgrade to retain these changes. The historical branch was not merged with current main.
