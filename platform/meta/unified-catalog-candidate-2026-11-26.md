# Unified catalog candidate — 2026-11-26

## Activated with exact-version approval

Platform version `a521d6aa-220f-4d40-bb15-bad41e1d4c08` was uploaded with `deploy: false` at 2026-11-26T06:48:36Z. Zack then approved this exact version. It was activated and verified at 2026-11-26T06:50:21Z on deployment `8814cb64-47a4-4fac-a8e4-b6c8a37b6542`, with 100% traffic. The earlier Queue approval was not reused.

- Worker: `platform-main-api`
- Source: `5c46a5365758f42d9d3f260bb028309715ff203c`, based on runtime `61a83d210d91ed88dc59dcd2aab3f2061c005c25`
- Bundle SHA-256: `d9b082fd03a8d6c2f9e1d377bd41d0494517c7c7b4a62cc1bc8bceb459c3f50d`
- Bundle bytes: 4,105,576
- Previous active version: `f6fa1805-c962-4c19-b863-4d092b3c6c13`
- Previous deployment: `818127ad-b2ea-4065-a485-27aaa9642aba`

Before and after upload, deployment, settings, source bytes and hashes were read back. The candidate inherits all 63 bindings, retains the compatibility settings, and introduces no migrations. The approved Queue correction remains in this source. Primary checkout receipt commits through `fc620167` add no runtime changes; preparation used an isolated worktree and did not edit the primary checkout.

## What changes

Discovery lists 3,944 canonical OpenAPI operations with 2,947 CLI aliases over 2,944 endpoints. This makes 1,000 API-only entries reachable through bounded search and schema lookup. An entry being discoverable does not grant execution. Existing ownership checks, executable policies and descriptor versions are preserved. Responses distinguish unavailable execution from missing installation, identity or schema data. Offline coverage and drift reports identify changes for review; they do not claim live acceptance.

The new metadata index is bundled in the Worker. Its SHA-256 is `4acbba07a82241294043c802c34a52ac7bdef8adde773158c6531f338c3f23ea`. Complete operation document hashes and R2 keys did not change, so this upload needs no separate index publication. The artifact set includes four documented OpenAPI exclusions.

## Evidence

Reused same-source checks: 115 focused API tests, ten publisher tests, three coverage/drift tests, API typecheck and touched lint. Publisher dry-run verified all 3,944 documents without uploads. The full repository suite was not repeated; its broad selector includes unrelated generated playground coverage.

Fresh candidate checks:

- Clean-source Wrangler dry-run build; source bytes read back after upload match the checked artifact.
- Workerd cold/warm schema loading for 12 registered provider policies; IDs, effects and descriptor hashes exactly match the approved Queue baseline.
- Bound R2 readback for those 12 pinned schemas, plus the API-only Access application list schema; compressed size, inflated size, digest and operation identity match.
- All 63 bindings and version configuration match the live baseline; no migrations; traffic remained on the approved Queue version until explicit catalog approval. Activation then changed only the approved version percentage.
- Before and after activation, health returns 200/ok. Six unauthenticated resource/catalog routes return 401.

Authenticated customer execution is not yet verified. The shared Worker uses Durable Objects and has no supported version URL for this test path; preview settings were not changed. No standalone caller with existing customer app-billing access was found. The coordinator will use the signed-in Crowded session to check ordinary-user discovery, API-only schema lookup, existing Queue reads and a saved dashboard.

Local preparation receipts live under `.local-runtime/unified-catalog-candidate/` in the `platform-discovery-catalog` worktree. Settings and bindings remain in local files and are not copied into this document. Activation checked the exact previous deployment, current settings, and both source hashes before switching traffic, and checked them again afterwards.
