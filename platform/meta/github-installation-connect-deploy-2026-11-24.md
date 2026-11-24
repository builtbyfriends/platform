# Existing GitHub installation connection — 2026-11-24

The API-only follow-up to [database preview redaction](./runtime-redaction-deploy-2026-11-24.md) is live at https://platform.buildwithfriends.dev. New app connection attempts start with GitHub user authorization, then show a Platform account chooser. This avoids GitHub's existing-installation Configure link, which drops the app's connection state.

| Item                    | Verified value                                                     |
| ----------------------- | ------------------------------------------------------------------ |
| Worker                  | `platform-main-api`                                                |
| Deployed source         | `9e29b741cd481a76771be05980b1ffc06579ea1b`                         |
| Active Worker version   | `9a233399-096a-4d41-9071-57fd3bceaf5a`                             |
| Active deployment       | `aca2eb98-835f-4aff-8c30-cd8bbf56ae0a`                             |
| Previous Worker version | `d76d644e-adfe-4aa2-908c-3751dfef0872`                             |
| Previous deployment     | `c3396fe4-8fae-42aa-b882-6189f8142588`                             |
| API bundle SHA-256      | `a0f05869529bf9b5a62e54cb788c7b85a995d8e36ad890488cab1222f6f6d07a` |

The downloaded live code and deployment matched the previous receipt before publication. The candidate inherited all 63 bindings from that exact version. Activation checked the old deployment again before changing traffic. Health, bindings and Worker settings passed post-publication checks; unauthenticated runtime calls returned 401. There were no schema, permissions, GitHub App registration, installation manifest or other Worker changes.

The chooser uses short signed choices bound to the GitHub person who authorized the first step. Confirmation checks access again with a fresh user token, including when installing on another account. The callback returns the original app state so scoped polling can finish. Expired or tampered choices show restart guidance; upstream failures return an error instead of appearing as an empty account list. Tokens remain transient on the server.

Validation: 27 focused callback and user-authorization tests pass on both feature branches. API typechecking and scoped lint pass (the forward branch retains existing lint warnings). Coverage includes new installation callbacks, existing installation selection, connected-client owner isolation, changed identity, revoked access, expired and tampered choices, safe upstream errors and HTML escaping. The runtime bundle builds successfully. A real signed-in existing-organization connection remains a separate browser check; this receipt does not claim that check passed.

The forward implementation is on `codex/infra-runtime` (code commit `0282c02`); the installed-baseline patch is on `codex/infra-runtime-live`. Merge the forward branch before the next normal installation upgrade to keep these fixes. The full runtime baseline remains `192e281e5f8c745e2b2c4b6737f6ed0c7a5a27c0`; this is not a runtime upgrade.

## End-to-end check and forward update

The real desktop connection subsequently completed through the account chooser: builtbyfriends showed Connected with 20 accessible repositories, and the browser returned the original state with bound=1. The initial failed authorization attempt was not reproduced with a fresh attempt; its exact cause is unconfirmed. Optional safe diagnostics were tested and retained locally, but were not deployed.

The forward branch brought in main `add42ffd0877971d70432e741743a86762be8093` at merge `978b23deaa62a502c574bc54950dd74472f86c32`, without conflicts or changes to the historical live branch. Post-merge API typechecking passed. Of 154 selected OAuth, runtime, billing and deployment-execution tests, 153 passed. The account-deletion billing test failed because legacy Worker cleanup returned 503; the same test failed identically on an isolated checkout of main `add42ffd0877971d70432e741743a86762be8093`. No deployment was made from the refreshed baseline.
