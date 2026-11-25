# Queue delivery controls — 2026-11-25

The tenant-scoped queue pause and resume API is live at https://platform.buildwithfriends.dev. Linked published apps can change delivery after a fresh ownership, deployment, consumer and current-state check. Pausing delivery does not purge messages; new messages can still arrive and retention expiry still applies.

| Item                    | Verified value                                                     |
| ----------------------- | ------------------------------------------------------------------ |
| Worker                  | `platform-main-api`                                                |
| Deployed source         | `0319181bf8e5da100c5743c0b15796a3412e6454`                         |
| Active Worker version   | `454805bb-8656-483a-a9c7-d87a83cb2461`                             |
| Active deployment       | `3eb09220-e874-496c-a6ec-f842e597392c`                             |
| Previous Worker version | `f24896ef-4d80-4f52-a419-68d97e552deb`                             |
| Previous deployment     | `91c1e2a0-9e0d-4173-9d44-98cc2e9f66a3`                             |
| API bundle SHA-256      | `eb4209584a1a9b7f0c277f0055d359ef55d665b1844d17aba142280f702fd292` |
| Bundle size             | 3,186,660 bytes                                                    |
| Verified at             | `2026-11-25T11:03:31.847Z`                                         |

Live code and settings matched the preceding [queue status receipt](./queue-status-deploy-2026-11-25.md) before upload. Upload and activation rechecked the exact deployment and settings. The candidate inherited all 63 bindings; runtime settings, exports, placement and bindings are preserved. Release annotations identify the new version. No proxy, tenant Worker, schema, customer data, plan, payer or installation changes were made.

After activation at 100%, the live module SHA-256 matched the checked artifact. Health passed. Unauthenticated resource inventory, inspection, execution and Activity requests returned 401. The compatible app release shipped first, as reported by its deployment owner: source `5d2ae811`, version `33602621-81aa-4572-901d-5585cd6ce112`, deployment `72f1be8c-3e6e-4bfc-bd57-4f36a2dfaef3` at 100%, with deploy readiness and public health passing.

The write sends only `settings.delivery_paused` through Cloudflare's [partial queue update](https://developers.cloudflare.com/api/resources/queues/methods/edit/). It doesn't replace other queue settings. The expected delivery state is checked just before the write; this isn't atomic compare-and-set because the provider has no documented conditional state token. A changed or unknown state refuses the operation. A timeout, changed ownership or route, or unverifiable outcome after a write attempt returns unknown without retry. Successful operations reread delivery and consumer settings; backlog stays unavailable until a separate status refresh. [Cloudflare's pause guide](https://developers.cloudflare.com/queues/configuration/pause-purge/) describes retention and delivery behavior.

Validation: 104 focused integration tests pass on both forward and historical sources (65 queue and 39 existing), plus API typecheck, scoped lint, formatting and the API-only build. Tests cover strict inputs, owner/resource isolation, preview and publication restrictions, active route and dispatch consumer fences, changed ownership or deployment before and after a write, expected-state conflicts, flag-only PATCH requests, timeout bounds and uncertain outcomes without retries. Historical production source matches forward `313491d`; the existing historical test owner-prefix literal remains because the newer APP constant is absent. A full repository check wasn't run for this slice.

No live queue was paused or resumed. Provider partial-update semantics were checked against current official documentation, and mutation behavior was tested through mocked provider responses with the integration database. No customer queue or complete customer delivery flow was exercised. Private previews reject queues and schedules; normal paid-plan publishing and sufficient AI credit remain requirements for that test. No billing bypass or operator provisioning was used.

Forward source: `313491d` on `codex/infra-runtime`. Historical source: `0319181` on `codex/infra-runtime-live`. Keep the forward change when upgrading; don't merge the historical branch into current main. Local snapshots, artifact and API receipts are under `.local/queue-delivery/` in the historical worktree.

Rollback restores the preceding queue-status version after checking this deployment and its settings are still current:

Run from the historical worktree (`codex/infra-runtime-live`):

```sh
node .local/queue-delivery/publish.mjs rollback
```

The previous version is retained. The rollback path has not been executed.
