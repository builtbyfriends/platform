# Owned provider collection reads

This change separates a collection's record identity from the provider resource identity. Durable Object collections still resolve the namespace through the existing ownership resolver; KV collections use the selected resource's owned namespace ID. Neither path accepts account or resource IDs from the caller. Existing authorization, descriptor-version and effect checks remain in place.

The new registered read is `workers-kv-namespace-list-a-namespace'-s-keys`. Its pinned schema has SHA-256 `0135d3090c6754af0e3bf7941de6e55421d2823cf4df2912f7ed333b5a5108d9`, 8,518 decoded bytes and 2,782 compressed bytes. The response exposes key names and optional expiration times in Unix seconds. It omits values and arbitrary metadata. The API supports prefix filtering and cursor pagination; see [Cloudflare's key-list API](https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/subresources/keys/methods/list/).

Collection policies now specify their own record-identity schema, optional UTF-8 identity limit, and approved additional query fields. KV prefixes are limited to 512 UTF-8 bytes. Key names are also limited to 512 UTF-8 bytes. Pages retain the existing default of 50 and range of 10–200 records, bounded cursor validation, duplicate-record checks, provider response limit of 256 KiB and eight-second timeout. Projected collection results are limited to 128 KiB. Missing continuation information remains unknown; it does not mean that the namespace is empty or complete. Schema drift that adds an unapproved collection query parameter fails closed.

This is a generic capability addition, with no product-specific UI. Crowded can use its existing versioned capability source and generated table/paging controls. The approved Platform API version is live. Its authenticated Crowded user flow remains unverified.

## Verification

- 191 tests passed across seven focused provider read/write and runtime-route files. An additional serialized-output-boundary test was then added; the final KV unit file passed all 32 tests. That gives coverage of 192 distinct cases on unchanged implementation source.
- The four new authenticated route cases cover separate metadata/list operation discovery, owned namespace paging, version/effect/scope rejection, missing or corrupt artifacts, provider failures and ownership changes during a read.
- The existing Durable Object unit file was not changed and passed. API TypeScript and scoped type-aware lint passed; formatting and whitespace checks passed.
- A local Workerd probe loaded the pinned schemas from fixture R2 storage and compared cold and warm registry results. It compiled ten provider policies: nine reads and one write. It did not invoke a provider or use a live customer database.
- The affected-test selector listed 271 of 723 files. The broad suite and workspace check were not repeated under the parent's focused-check instruction; earlier broad runs had unrelated generated playground configuration and Workerd/admin setup failures.

## Compiled coverage

| Resource                 | Registered provider operations                                     |
| ------------------------ | ------------------------------------------------------------------ |
| Database                 | Metadata read                                                      |
| Files                    | Metadata, managed domain and CORS reads; reviewed CORS replacement |
| Key-value namespace      | Metadata and paginated key-name reads                              |
| Queue                    | Metadata read                                                      |
| Hyperdrive               | Safe metadata read                                                 |
| Durable Object namespace | Paginated instance IDs and stored-data flags                       |

The new KV descriptor version is `e82b638db6d653837d2fb804cc9ef2679d9ab668026dacafab382948c8364d9e`. The Durable Object descriptor version changes to `56c6ae2205f590ac412115dcb85a731ddd4fde6b1f45899372e563f7e9474778` because its explicit policy and collection bounds are included in the version. Saved views using its previous version must refresh their capability definition. The eight other previously compiled provider descriptor versions are unchanged.

KV value reads/writes, queue consumer collections, arbitrary catalog operations, account-wide enumeration, child-resource mutations and new inventory resource types remain unsupported by this slice. Local evidence is under `.local-runtime/collection-*`.

## Approved activation — 2026-11-26

The owner approved version `b6b00750-4cd9-4b67-ae6a-2fa68a9bdd0b`. It is active on `platform-main-api` at 100% traffic in deployment `56a68fea-fe24-44a8-93b0-44133288e103`. Verification completed at `2026-11-26T05:12:45.298Z`.

- Source: `f667b16c49eed10ff57e33d0190dbfbd80f4de9d`, the reviewed collection commit integrated onto the verified live baseline.
- Bundle SHA-256: `29faaef08704128a865dca2197192d13cbde70f97f87d2514d797f5f32641e48` (4,052,590 bytes).
- Previous live version: `e5603e1f-0538-4377-98c0-c9868cfea949`, deployment `74212e99-d824-463a-819c-747c21b62cae`.
- Before switching traffic, the guarded helper checked the expected live deployment, both version sources and settings, then repeated the deployment/settings checks. It checked the active source and deployment after the switch. No unexpected drift was found.
- All 63 bindings and configuration were preserved. No migrations were included. Health returned 200 with status `ok`.
- Unauthenticated calls to `projects.capabilities`, `projects.resourceOperations`, `resources.invoke`, `projects.resources`, `resources.inspect` and `resources.execute` returned 401.
- All ten remote pinned schema artifacts matched their recorded sizes, hashes and operation identities before upload. The integrated API, deploy-core and edge trees matched the checked isolated source, so focused test, type, lint and cold/warm schema evidence was reused.

This candidate extends the verified shared API baseline. It does not include unrelated Platform main changes: the local `origin/main` reference was `e22d31b1`, with 157 commits not integrated, including unrelated migrations. That reference was not refreshed during this scoped preparation.

Authenticated customer acceptance remains pending. No customer KV data or provider configuration was changed during deployment verification. Crowded production was not changed.

Local receipt: `.local-runtime/owned-collection-candidate/activation-verified.json`.
