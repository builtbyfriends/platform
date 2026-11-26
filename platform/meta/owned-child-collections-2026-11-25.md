# Owned child collection reads

The shared provider adapter now supports complete, bounded collections and collections nested beneath a named result property. It also resolves explicitly selected scalar fields through pinned schema alternatives. This enables two reads without adding product-specific runtime handlers or dashboard components:

- `queues-list-consumers`: consumer ID, type, creation time and selected delivery settings. Worker names, queue names and dead-letter queue names are omitted.
- `r2-list-custom-domains`: domain, enabled state, minimum TLS version, domain ownership status and SSL status. Zone IDs, zone names and cipher lists are omitted.

Both operations take `{}` (or `{ query: {} }`). Account, queue, bucket and jurisdiction come from the selected project-owned inventory resource. Caller-supplied parent IDs, child IDs, query fields, headers and pagination controls are rejected. Authorization is checked before and after the provider read. Existing registered-operation version/effect checks apply.

The returned shape is the existing `provider-read` envelope, with `data.name`, `data.records` and `data.pagination`. Complete lists return `{ limit: null, count, nextCursor: null, hasMore: false }`. This is distinct from cursor APIs, where missing continuation remains unknown. A response exceeding 200 records, 256 KiB of provider JSON or 128 KiB of projected output fails rather than returning a partial list marked complete. R2 rejects `result_info`. Queue accepts it only when page 1 is also the only page, both counts equal the returned row count, `per_page` is an integer from 1 to 200 covering the rows, and no unknown pagination keys exist. Partial pages and unknown pagination fail. Missing arrays, malformed identities and duplicate identities also fail. Empty arrays are valid complete results.

R2's pinned result stores rows under `result.domains`; Queue rows are directly under `result`. Queue consumer variants are validated against the full response schema before approved fields are projected. Its trusted read policy explicitly permits nullable diagnostic arrays and nullable concurrency in three named schema components. Original pinned artifacts and request validation stay unchanged; changed component types or annotations fail preparation. Selected write-only fields fail schema preparation. This does not grant arbitrary schema fields or additional provider operations.

## Pinned contracts

| Operation                | Schema SHA-256                                                     | Decoded / gzip bytes | Descriptor version                                                 |
| ------------------------ | ------------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------ |
| `queues-list-consumers`  | `c6b5cf6b6d6c1e31f899ac08a9b618d7d2cae9a1c9b83dac7ffa8c9cb1844744` | 8,736 / 2,479        | `d27fe1b384d77dfab3f8d3882ec4db80750cda6c356a2caf22f30df451e14dfb` |
| `r2-list-custom-domains` | `db45883e3b78c2cfd1469fb85db59550b82fb91eb6c4a071a300a2b00d55d105` | 7,299 / 2,396        | `814e962c94179b3804ac14b9ccbcb808da2b35cb293ab0a6b9a5f26a0a009c33` |

Provider references: [Queue consumers](https://developers.cloudflare.com/api/resources/queues/subresources/consumers/methods/list/), [R2 custom domains](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/domains/subresources/custom/methods/list/).

## Verification and limits

- New unit coverage: 27 cases. New authenticated runtime coverage: eight cases, covering both products, registered schema discovery, independent artifact availability, version/effect/input rejection, cross-tenant access, changing ownership and hidden provider errors.
- The eight-file focused run passed 226 cases and found one outdated assertion expecting three R2 read policies. After adding the fourth expected policy, the affected 18-case unit file passed. Together these verify all 227 distinct focused cases on unchanged implementation source.
- API TypeScript, scoped type-aware lint, formatting and whitespace checks passed. The conservative affected-test list is retained locally; broad tests and workspace checking were not repeated under the focused-check direction because earlier runs had unrelated generated playground and Workerd/admin setup failures.
- Local Workerd loaded all twelve pinned operation schemas from fixture R2 and produced equal cold/warm registry descriptors. All ten previously compiled descriptor versions remain unchanged. No external provider request or live customer resource was used by these tests.
- DED-575 correction: 134 focused cases pass across the full authenticated runtime-operation suite and both provider/child-collection unit suites. This includes 43 child-collection cases. The initial sandbox run passed 133 and failed only a Workerd loopback bind; the same run passed all 134 with local-bind permission.
- A bounded GET-only probe on 2026-11-26 at 06:15:05Z read the three existing Platform Worker queue bindings. All three had null diagnostic arrays, omitted concurrency and proven single-page metadata. The corrected adapter validated the raw envelopes and projected all returned rows. No provider values or identities were retained. Nullable concurrency is supported by the official prose and synthetic tests; it was not present in these live responses.
- Cold/warm Workerd descriptor construction passes for all twelve operations after the correction. Only `queues-list-consumers` changes version; the other eleven remain unchanged.

This corrected source is not deployed. Candidate `34ebdd8f-df10-49d7-afed-7176519ecf81` contains the earlier failing implementation, remains at zero traffic and must not be activated. The live probe checks the local adapter with real provider responses; deployed authenticated-route and generated UI acceptance remain pending. Provider empty-page metadata with `total_pages: 0` is not yet evidenced or supported; an empty array without pagination metadata remains valid. Child detail references/tokens, child writes/deletes, new inventory resource types, account-wide listing and broader template provisioning are outside this change.

Local evidence: `.local-runtime/child-collection-*`, `.local-runtime/child-collection-schema/`, `.local-runtime/queue-correction-*`. The live receipt stores only type/count/pass summaries; the descriptor parity receipt records eleven unchanged versions.
