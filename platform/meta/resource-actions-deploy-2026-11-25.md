# Connected app resource actions — 2026-11-25

The API-only follow-up to [customer activity](./customer-activity-deploy-2026-11-24.md) is live at https://platform.buildwithfriends.dev. Resource inventories now describe supported actions. Connected apps can open bounded text files, save a file using its current ETag, and list or read key-value entries through `resources.execute`.

| Item                    | Verified value                                                     |
| ----------------------- | ------------------------------------------------------------------ |
| Worker                  | `platform-main-api`                                                |
| Deployed source         | `8e0815b8f1cd9f04273ce18bd4da58855a4d55f2`                         |
| Active Worker version   | `4b6d6197-2c9d-4bee-a423-7c6b771296d6`                             |
| Active deployment       | `ff2ac659-dcee-484a-a765-c36eaf3108fc`                             |
| Previous Worker version | `e2ff5f2e-a4a4-4772-999f-acc9a716a6e2`                             |
| Previous deployment     | `293bd382-4e93-4eba-848a-c17da2cf7dc8`                             |
| API bundle SHA-256      | `a8cdd6084649f716e43f7bdf66ca0ac487250fbba0235b4b23820abe5e278cab` |

Before upload, the downloaded live code and retained baseline matched the preceding receipt byte for byte. The inactive version inherited all 63 bindings from that exact live version. Activation rechecked the current deployment, candidate configuration, source and artifact. After activation, health passed; unauthenticated resource, inspection, action and activity calls returned 401. Bindings and Worker settings match the original snapshot. No schema, provider proxy, tenant Worker, data, plan, payer or installation manifest changes were made.

Validation: 26 runtime integration tests pass on both forward and historical branches. They cover connected-client and owner isolation, resource scope, bounded inputs, binary refusal, credential-key redaction, conditional file updates, metadata preservation, conflict and uncertain results, unsupported handlers, and authorization failure after a provider write. Both API typechecks and scoped lint pass; the historical runtime bundle builds. No full repository suite result is claimed. Signed-in customer file editing and key browsing remain separate end-to-end app checks.

Files are limited to 64 KiB of UTF-8. Saves use only the conditional endpoint and preserve HTTP/custom metadata. A changed ETag returns conflict, and an uncertain save asks the caller to reopen the file rather than retry blindly. Legacy reads without native object metadata remain read-only. An older handler without conditional writes returns unavailable; there is no unconditional fallback. The connected application remains responsible for the actual person's or bot's write permission. Platform checks app ownership and resource binding, rechecks before writing, and reports uncertainty if scope changes during a save. Provider writes and ownership changes don't share an atomic transaction.

Forward implementation: `628bb14` on `codex/infra-runtime`. Deployed backport: `8e0815b` on `codex/infra-runtime-live`, continuing the installed historical baseline `192e281e5f8c745e2b2c4b6737f6ed0c7a5a27c0`. Merge the forward branch before a normal installation upgrade to retain these endpoints. The historical branch must not be merged into current main. Local publication evidence is retained under `.local/resource-actions/` in the historical worktree; it is not committed.
