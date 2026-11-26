# Owned child reads — DED-580 checkpoint

## Implemented, not deployed

The shared schema-backed read adapter now supports a selected child under an owned parent. Two installed policies use it: Queue consumer details (`queues-get-consumer`) and R2 custom domain configuration (`r2-get-custom-domain-settings`). They use the existing invocation route and generated-view capability model, with input `{ child: <selected collection identity> }`. No new grants, account selectors, provider URLs, writes or product-specific renderer were added.

The adapter injects the account and parent from the authorized resource record. It validates the child against the exact parameter schema and a bounded policy. It checks the complete owned collection before and after the detail fetch; an absent, duplicate or removed child causes failure. The detail identity must equal the selection. Each request retains the existing pre/post ownership checks. The three reads share an eight-second deadline. Missing collection schema makes the child capability unavailable, rather than bypassing membership proof. Output is projected: worker names, zone IDs and provider credentials stay private. R2 cipher settings are bounded structured data.

The detail descriptor includes its parent descriptor version, so changing the membership policy invalidates old child views. Existing policies retain their descriptor construction and tested version hashes. These policies currently require complete collections of at most 200 entries; paginated or unknown-completeness collections are not accepted as membership proof.

Files: `cloudflare-provider-read.ts`, `resource-operations.ts`, child unit tests, existing provider unit/route tests, and two immutable OpenAPI fixtures. The source branch is `codex/owned-child-details`, based on `9c48d6bb`, in the isolated `platform-owned-child-details` worktree. No shared checkout or traffic was changed.

## Checks and remaining acceptance

Focused verification covers 158 tests across provider unit tests, child unit tests and operation/catalog integration tests, including real Workerd D1. The first combined run had 157 passing and one expected-artifact-list assertion failure; the assertion was updated for the added schema and its focused rerun passed. API typecheck and touched type-aware lint passed. The smart selector lists 273 of 725 files because Platform fixtures conservatively select their owning suites; that broad run and the whole-repository suite were not run for this bounded handoff.

Before deployment, use the ordinary review/build and exact-version activation process. Verify the two existing immutable schema documents in the installation's R2 store, and include both parent schemas. Then test a signed-in user's collection row action and a saved generated detail view against real owned resources. Unit and route fixtures are not live acceptance. The shared Platform currently runs the earlier unified catalog; these child reads are source-only.

Crowded needs no transport or rendering contract change. Its existing capability source can load the returned descriptor with `{ child }`; a collection Table rowAction supplies `consumer_id` or `domain`. Compose an on-demand detail source with the exact advertised version and preserve the collection source. Label the action from the operation title, and show the failure if membership changes. The current first-open unfamiliar-resource path already asks the bot to compose from capabilities. A real generated view still needs acceptance under DED-581.

## Ownership/discovery continuation — implemented in source

The continuation adds the server-owned resource-reference union and the bounded Access ownership/discovery slice proposed below. Its ledger and activation limits are in [runtime-resource-coverage-2026-11-26.md](runtime-resource-coverage-2026-11-26.md). Inventory, catalog selection and invocation share the references. Provisioned resource IDs and policies are unchanged. Access references use opaque stable installation/project/role IDs and revalidate ready configuration, project reconciliation generation and exact private application identity. Missing, changed, malformed, shared or ambiguous proof is withheld.

Access has no executable policy yet: the operation list is unavailable/empty and invocation returns `operation_unavailable`. This is a new-family ownership proof, not live provider-read coverage. Shared Platform remains unchanged. The following design notes explain the source boundary and remaining work.

The provisioning boundary remains the seven-type `resources` table model in `schema.ts` and `getProjectResources`. Runtime inventory now wraps it in `RuntimeResourceReference`; its product map is in `app-runtime-resource-reference.ts`. An arbitrary OpenAPI product or a model-supplied ID is not a project resource. Adding enum members alone would not establish ownership.

The reference union keeps provisioned-resource identity and adds references backed by authoritative project records. Access references carry project/installation scope, a server-only provider locator and proof generation; shared resolution and comparison functions revalidate them. The model can select an opaque reference but cannot construct proof or supply the underlying provider locator. Discovery remains independent from execution policy.

The new-family proof uses Cloudflare Access applications: `project_zero_trust` stores project-owned protected/bypass application IDs, names, reconciliation operation and updated time. `zero-trust/project.ts` provisions them and `zero-trust/state.ts` exposes safe project status. The runtime exposes ready, reconciled applications as generic Resource nodes. Access configuration reads still need an installed, schema-pinned projection policy; raw policies, audiences and authentication internals stay private. The 14 added catalog cases cover foreign/raw-handle selection, changed application and configuration identity, reconciling/error state, changed reconciliation generation, missing records, ambiguous/shared ownership and late revocation.

Containers need separate work: the `container` resource type includes historical handles, while managed deployment manifests plus dispatch namespace bindings provide the stronger proof. Existing `operator/sandbox-operations.ts:verifyApplication` compares manifest identity and the application's Durable Object namespace. It must not be reused as an account-wide operator grant. Extract a bounded project-scoped resolver only after establishing its live manifest contract; do not treat a string ID or name match as proof.

Crowded's reconciliation already keeps unknown inventory kinds as generic Resource nodes. The runtime feeds it the opaque ID and safe label, with no new product-specific frontend switch. Observed deployment connections remain separate from ownership-only inventory.

Continuation verification: 465 tests pass across eight runtime/provider files, including the real Workerd D1 cases with host loopback access; API typecheck, touched type-aware lint and diff whitespace checks pass. The affected selector lists 273/725 files. That broad selection and the full suite were not run. The whole-repository typecheck was attempted but stops in unrelated `playground/pg-api-test` because its generated `.bwf/tsconfig.json` and `@schema` are missing. Do not mark the whole check or native acceptance passed.


## Checked zero-traffic candidate — 2026-11-26 18:10 UTC

Runtime source5a81b0b3cd40ce846e279c53cf982d581f660054 is backed up on origin/codex/owned-child-details. The clean-source API bundle is4,112,003bytes, SHA256 `510995809d0a5a19a2d474dc0bf473195313d3c6d5a70bfebbc4665efea8684d`. Uploaded candidate `801cbe58-93c7-4c90-87d2-5649d4088e70` is inactive. Shared traffic remains on approveda521d6aa/deployment8814cb64. No activation is claimed.

Fresh preparation checks: all14 provider descriptors load identically in cold/warm Workerd; the12 existing descriptor identities/effects/versions match the approved baseline. The two child reads have the expected descriptors. All14 immutable R2 schema objects pass compressed/inflated size, SHA256 and operation-identity readback. Candidate and active source bytes were checked after upload; all63 inherited bindings and compatibility settings are preserved, with no migrations or traffic change. Live baseline health isok and six unauthenticated resource/catalog routes still return401. These baseline checks don't establish authenticated candidate execution.

The earlier465 tests and API types/touched lint apply to unchanged runtime source. Whole-repository checks retain the unrelated generated playground limit recorded above. Preparation receipts are in `/tmp/infra-provider-owned-child-candidate`; binding settings and credentials aren't copied into this document. Candidate activation retains the owner's exact-version boundary. Native child selection and saved generated-detail acceptance remain required after activation.
