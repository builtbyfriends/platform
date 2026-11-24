# Database preview redaction — 2026-11-24

The API-only follow-up to [runtime inspection](./runtime-inspection-deploy-2026-11-24.md) is live at `https://platform.buildwithfriends.dev`. Database previews now redact common API-key and access-key column names, including camel-case, underscore and hyphen forms. Ordinary fields such as `api_version`, `access_count` and `public_key` remain readable. This uses column names; it does not find secrets embedded in ordinary text or JSON.

| Item                    | Verified value                                                     |
| ----------------------- | ------------------------------------------------------------------ |
| Worker                  | `platform-main-api`                                                |
| Deployed source         | `952d14d90b141a2a7fac5ef64bf5025622387829`                         |
| Active Worker version   | `d76d644e-adfe-4aa2-908c-3751dfef0872`                             |
| Active deployment       | `c3396fe4-8fae-42aa-b882-6189f8142588`                             |
| Previous Worker version | `1bd6a9cd-9943-49b5-b084-e1ccecae5c7e`                             |
| Previous deployment     | `6582e095-827b-4fce-912f-d5d51f4f0e64`                             |
| API bundle SHA-256      | `92ccad48af65108fef0e0a0c26b084f2361a5c175ffae58bd2c9fbe59924deb3` |

The deployment and downloaded code matched the previous receipt before publication. The candidate inherited all 63 bindings from that exact version. Activation was fenced against the previous deployment, and post-publication checks confirmed unchanged bindings and Worker settings, healthy API status, and `401` responses for unauthenticated runtime calls. No schema, payer, installation manifest or other Worker changes were made.

Validation: 11 runtime tests pass on both the live-baseline and forward branches, including a real SQLite regression for credential and ordinary columns. API typechecking and scoped lint pass. An authenticated real-app data inspection remains an end-to-end check; it was not replaced with a mock live success.

The forward implementation remains on `codex/infra-runtime`, and the installed-baseline patch remains on `codex/infra-runtime-live`. Merge the forward branch before the next normal installation upgrade so the runtime inspection and redaction changes survive it. The full installed runtime baseline remains `192e281e5f8c745e2b2c4b6737f6ed0c7a5a27c0`; this publication is not a full runtime upgrade.
