# Owned provider collection reads

This change separates a collection's record identity from the provider resource identity. Durable Object collections still resolve the namespace through the existing ownership resolver; KV collections use the selected resource's owned namespace ID. Neither path accepts account or resource IDs from the caller. Existing authorization, descriptor-version and effect checks remain in place.

The new registered read is `workers-kv-namespace-list-a-namespace'-s-keys`. Its pinned schema has SHA-256 `0135d3090c6754af0e3bf7941de6e55421d2823cf4df2912f7ed333b5a5108d9`, 8,518 decoded bytes and 2,782 compressed bytes. The response exposes key names and optional expiration times in Unix seconds. It omits values and arbitrary metadata. The API supports prefix filtering and cursor pagination; see [Cloudflare's key-list API](https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/subresources/keys/methods/list/).

Collection policies now specify their own record-identity schema, optional UTF-8 identity limit, and approved additional query fields. KV prefixes are limited to 512 UTF-8 bytes. Key names are also limited to 512 UTF-8 bytes. Pages retain the existing default of 50 and range of 10–200 records, bounded cursor validation, duplicate-record checks, provider response limit of 256 KiB and eight-second timeout. Projected collection results are limited to 128 KiB. Missing continuation information remains unknown; it does not mean that the namespace is empty or complete. Schema drift that adds an unapproved collection query parameter fails closed.

This is a generic capability addition, with no product-specific UI. Crowded can use its existing versioned capability source and generated table/paging controls. Its live user flow has not been checked for this change, and this source has not been deployed.

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
