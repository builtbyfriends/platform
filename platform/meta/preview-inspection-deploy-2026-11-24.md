# Private preview inspection guard — 2026-11-24

The API-only follow-up to [GitHub connection](./github-installation-connect-deploy-2026-11-24.md) is live at https://platform.buildwithfriends.dev. Connected apps can inspect a private preview only while it is active, belongs to their client, and has not expired. These checks run before reads and again before returning data. Existing project ownership and resource checks remain in place.

| Item                    | Verified value                                                     |
| ----------------------- | ------------------------------------------------------------------ |
| Worker                  | `platform-main-api`                                                |
| Deployed source         | `b5db82779e2c4dddf49b705736bd96dd67c26c52`                         |
| Active Worker version   | `9b12bf40-a302-468a-ad0d-2fa6b64e264f`                             |
| Active deployment       | `aee7df70-bfb1-42e9-9a9b-e3edaeba9fb3`                             |
| Previous Worker version | `9a233399-096a-4d41-9071-57fd3bceaf5a`                             |
| Previous deployment     | `aca2eb98-835f-4aff-8c30-cd8bbf56ae0a`                             |
| API bundle SHA-256      | `f344ee73f59c99130578e6c12949492c3b36995c7d036e25c68528c46834bc82` |

The downloaded live code matched the previous receipt before upload. Activation was fenced against that exact deployment. All 63 bindings and Worker settings were preserved. Post-deployment health passed; unauthenticated resource, inspection and activity calls each returned 401. No schema, app data, plan, payer, permission or other Worker changes were made.

Validation: 13 runtime integration tests pass on the forward and historical branches, including owned-preview reads, expired and foreign-client refusal, and expiry during a storage read. API typechecking, scoped lint and the historical runtime bundle build pass. Authenticated inspection of a real hosted preview is a separate app check; this receipt does not claim it passed.

The forward code commit is `4b71b56` on `codex/infra-runtime`. The deployed patch is `b5db827` on `codex/infra-runtime-live`, built from the historical runtime baseline `192e281e5f8c745e2b2c4b6737f6ed0c7a5a27c0` with the preceding API-only patches. Merge the forward branch before a normal installation upgrade to preserve the guard. The historical branch has not been merged with current main, and this publication is not a runtime upgrade.
