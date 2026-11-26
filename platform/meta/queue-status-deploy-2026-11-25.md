# Queue status — 2026-11-25

The read-only queue status API is live at https://platform.buildwithfriends.dev. Linked published apps can inspect queue delivery settings, an approximate backlog and verified consumer settings. The action doesn't read messages, change delivery, retry jobs or provision resources.

| Item                    | Verified value                                                     |
| ----------------------- | ------------------------------------------------------------------ |
| Worker                  | `platform-main-api`                                                |
| Deployed source         | `2d335f23835b55fcb457a5ef0b7deb840228f58f`                         |
| Active Worker version   | `f24896ef-4d80-4f52-a419-68d97e552deb`                             |
| Active deployment       | `91c1e2a0-9e0d-4173-9d44-98cc2e9f66a3`                             |
| Previous Worker version | `83dcdae6-0253-49f5-9fc8-3d22a4f60c21`                             |
| Previous deployment     | `cfa78272-e0c0-4036-a66d-e80ca4ad0e7e`                             |
| API bundle SHA-256      | `a2bab7c60976a44cf6ed59ce114326a8bbc7d19e7279b61184c8a9a046bbbca2` |
| Bundle size             | 3,184,268 bytes                                                    |
| Verified at             | `2026-11-25T10:13:25.133Z`                                         |

Before upload, live code and settings matched the preceding [database inspection receipt](./database-inspection-deploy-2026-11-25.md). Upload inherited all 63 bindings from that version. The upload and activation guards rechecked the exact deployment and settings. Runtime settings, exports, placement and bindings are preserved; release annotations identify the new version. No proxy, tenant Worker, schema, customer data, plan, payer or installation changes were made.

After activation at 100%, the live module's SHA-256 matched the checked artifact. Health passed. Unauthenticated resource inventory, inspection, execution and Activity requests returned 401. The compatible app parser shipped first, as reported by its deployment owner: source `a0a8632c`, version `5fb00873-f38d-4ed2-88eb-a91fda26bc27`, deployment `e19fe21c-6ef6-453c-9c99-b0a8964d8ae6` at 100%.

Provider shape was checked with GET requests against an existing installed infrastructure cron queue at `2026-11-25T10:05:55.984Z`. No message bodies were read, and no settings changed. The response used consumer `script`, not `script_name`; omitted `delivery_paused` and `max_concurrency`; and returned zero count, bytes and oldest timestamp. This evidence led to regressions for missing pause information, automatic concurrency and the unknown timestamp sentinel. The sanitized receipt is `.local/queue-status/provider-shape.json` in the historical worktree.

Missing pause information reports unknown, not running. An explicit unpaused state means provider delivery is enabled; it doesn't establish that customer code is healthy or that Platform suspension gates allow execution. Missing or null maximum concurrency means automatic. A zero oldest-message timestamp becomes null. Missing or failed metrics stay unavailable, distinct from an observed empty backlog. Cloudflare describes [queue metrics](https://developers.cloudflare.com/api/resources/queues/methods/get_metrics/) as best-effort and documents [consumer settings](https://developers.cloudflare.com/api/resources/queues/subresources/consumers/); the live GET supplied the exact response-field evidence.

Validation: 72 focused runtime integration tests pass (33 queue and 39 existing), plus API typecheck, scoped lint, formatting and the API-only build. Tests cover owner/resource isolation, exact provider queue identity, dispatch consumer identity, active-deployment route/token checks, route and ownership changes during a read, absent or invalid measurements, fractional batch wait and timeout behavior. Historical production source matches forward `cb341d5`; only the test fixture uses its existing owner-prefix literal because the newer APP constant is absent. A full repository check wasn't run for this slice.

No customer queue or full customer delivery flow was exercised. Private previews reject queues and schedules. A new customer test needs normal paid-plan publishing and approval, plus sufficient AI credit for the builder; operator provisioning or billing changes weren't used to get around those limits.

Forward source: `cb341d5` on `codex/infra-runtime`. Historical source: `2d335f2` on `codex/infra-runtime-live`. Keep the forward change when upgrading; don't merge the historical branch into current main. Local snapshots, artifact and API receipts are under `.local/queue-status/` in the historical worktree.

Rollback restores the preceding database inspection version after checking this deployment and its settings are still current:

From the historical `platform-runtime-live` worktree:

```sh
node .local/queue-status/publish.mjs rollback
```

The previous version is retained. The rollback path has not been executed.
