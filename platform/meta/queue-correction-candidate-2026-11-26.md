# Queue correction candidate

Platform version `f6fa1805-c962-4c19-b863-4d092b3c6c13` is live at 100% after the owner's explicit approval of this exact version. The guarded activation was verified on 2026-11-26 at 06:41:21Z. It replaces the unusable child-collection candidate `34ebdd8f-df10-49d7-afed-7176519ecf81`, which remains inactive and must not be activated.

The checked source is `61a83d210d91ed88dc59dcd2aab3f2061c005c25`, the focused cherry-pick of `914cb8ed`. Its API, deploy-core and edge source trees match the tested isolated worktree. It extends the verified live source rather than merging unrelated Platform main changes or migrations.

| Receipt             | Value                                                              |
| ------------------- | ------------------------------------------------------------------ |
| Active version      | `f6fa1805-c962-4c19-b863-4d092b3c6c13`                             |
| Active deployment   | `818127ad-b2ea-4065-a485-27aaa9642aba`, 100%                       |
| Source              | `61a83d210d91ed88dc59dcd2aab3f2061c005c25`                         |
| Bundle SHA-256      | `142401c207f913c8339f4882ff68a2ec8fa1c25b67b1f53a70615660ae788509` |
| Bundle size         | 4,054,924 bytes                                                    |
| Upload checked      | 2026-11-26 06:19:42Z                                               |
| Previous version    | `b6b00750-4cd9-4b67-ae6a-2fa68a9bdd0b`                             |
| Previous deployment | `56a68fea-fe24-44a8-93b0-44133288e103`                             |

The guarded upload verified the candidate and active source hashes, preserved all 63 bindings and settings, and added no migrations. All twelve pinned operation artifacts passed bounded remote readback and integrity checks. Live baseline health was OK and six unauthenticated infrastructure endpoints returned 401. These health/access results apply to the live baseline, not the uploaded candidate.

Activation rechecked the previous deployment, both source hashes and candidate metadata before switching traffic. The active deployment and source match the approved candidate, all 63 bindings and settings are preserved, and no migrations were added. Post-activation health is OK. Unauthenticated requests to `projects.capabilities`, `projects.resourceOperations`, `resources.invoke`, `projects.resources`, `resources.inspect` and `resources.execute` return 401. Authenticated customer Queue/R2 reads and generated UI acceptance are still pending; these deployment checks do not claim that acceptance passed.

The correction passed 134 focused tests, API types, scoped type-aware lint and formatting. Cold/warm Workerd compilation agrees for twelve operations; only the Queue consumer descriptor changed. A bounded GET-only read of the three existing Platform Worker queues passed the corrected local adapter on 2026-11-26 at 06:15:05Z. It validated full real responses containing null diagnostic arrays and complete page metadata. Provider values and identities were not retained. This is local-adapter evidence against actual provider responses, not an authenticated candidate invocation.

The Worker already has version previews enabled, but the uploaded version returned no version URLs. Cloudflare [does not generate version URLs for Workers implementing Durable Objects](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/#limitations). No preview settings were changed to bypass this limit. The exact version was activated after approval; authenticated acceptance can now use the normal application route.

Evidence stays in `.local-runtime/queue-correction-candidate/`: `baseline.json`, `source-equivalence.json`, `build-receipt.json`, `schema-probe.json`, `schema-readback.json`, `upload-receipt.json`, `validation-receipt.json`, `preview-availability.json`, `owned-queue-read-receipt.json`, `activation.json`, `activation-verified.json`, `active-settings.json` and `active-deployment.json`. Source behavior and remaining limits are in [the child collection notes](owned-child-collections-2026-11-25.md).
