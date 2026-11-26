# Owned child collection reads

The shared provider adapter now supports complete, bounded collections and collections nested beneath a named result property. It also resolves explicitly selected scalar fields through pinned schema alternatives. This enables two reads without adding product-specific runtime handlers or dashboard components:

- `queues-list-consumers`: consumer ID, type, creation time and selected delivery settings. Worker names, queue names and dead-letter queue names are omitted.
- `r2-list-custom-domains`: domain, enabled state, minimum TLS version, domain ownership status and SSL status. Zone IDs, zone names and cipher lists are omitted.

Both operations take `{}` (or `{ query: {} }`). Account, queue, bucket and jurisdiction come from the selected project-owned inventory resource. Caller-supplied parent IDs, child IDs, query fields, headers and pagination controls are rejected. Authorization is checked before and after the provider read. Existing registered-operation version/effect checks apply.

The returned shape is the existing `provider-read` envelope, with `data.name`, `data.records` and `data.pagination`. Complete lists return `{ limit: null, count, nextCursor: null, hasMore: false }`. This is distinct from cursor APIs, where missing continuation remains unknown. A response exceeding 200 records, 256 KiB of provider JSON or 128 KiB of projected output fails rather than returning a partial list marked complete. Unexpected `result_info` is rejected for these non-paginated operations. Missing arrays, malformed identities and duplicate identities also fail. Empty arrays are valid complete results.

R2's pinned result stores rows under `result.domains`; Queue rows are directly under `result`. Queue consumer variants are validated against the full pinned response before approved fields are projected. Selected write-only fields fail schema preparation. This does not grant arbitrary schema fields or additional provider operations.

## Pinned contracts

| Operation                | Schema SHA-256                                                     | Decoded / gzip bytes | Descriptor version                                                 |
| ------------------------ | ------------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------ |
| `queues-list-consumers`  | `c6b5cf6b6d6c1e31f899ac08a9b618d7d2cae9a1c9b83dac7ffa8c9cb1844744` | 8,736 / 2,479        | `44035a0535ee190c2662e74b3013611eb0c17288cf51bf39ee966df210fe2674` |
| `r2-list-custom-domains` | `db45883e3b78c2cfd1469fb85db59550b82fb91eb6c4a071a300a2b00d55d105` | 7,299 / 2,396        | `814e962c94179b3804ac14b9ccbcb808da2b35cb293ab0a6b9a5f26a0a009c33` |

Provider references: [Queue consumers](https://developers.cloudflare.com/api/resources/queues/subresources/consumers/methods/list/), [R2 custom domains](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/domains/subresources/custom/methods/list/).

## Verification and limits

- New unit coverage: 27 cases. New authenticated runtime coverage: eight cases, covering both products, registered schema discovery, independent artifact availability, version/effect/input rejection, cross-tenant access, changing ownership and hidden provider errors.
- The eight-file focused run passed 226 cases and found one outdated assertion expecting three R2 read policies. After adding the fourth expected policy, the affected 18-case unit file passed. Together these verify all 227 distinct focused cases on unchanged implementation source.
- API TypeScript, scoped type-aware lint, formatting and whitespace checks passed. The conservative affected-test list is retained locally; broad tests and workspace checking were not repeated under the focused-check direction because earlier runs had unrelated generated playground and Workerd/admin setup failures.
- Local Workerd loaded all twelve pinned operation schemas from fixture R2 and produced equal cold/warm registry descriptors. All ten previously compiled descriptor versions remain unchanged. No external provider request or live customer resource was used by these tests.
- The pinned Queue schema describes `max_concurrency` as numeric despite mentioning null in its prose. This implementation follows the pinned schema and fails a response containing null there; it does not silently reinterpret it or claim live provider compatibility has been checked.

This source is not deployed. Authenticated live reads and generated UI acceptance remain pending. Child detail references/tokens, child writes/deletes, new inventory resource types, account-wide listing and broader template provisioning are outside this change.

Local evidence: `.local-runtime/child-collection-*` and `.local-runtime/child-collection-schema/`.
