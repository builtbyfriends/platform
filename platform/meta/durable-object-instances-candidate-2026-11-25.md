# Durable Object instance reads

This candidate adds the pinned `durable-objects-namespace-list-objects` operation to the existing provider executor. It does not deploy a Worker or change a namespace.

The operation is available only for a managed resource whose current app bindings, deployment manifest, namespace metadata, host owner marker and host deployment marker agree. Discovery and execution use `resolveOwnedDurableObjectNamespace`; the inventory `cf_id` is a Worker name, not a namespace ID. The route pins the proved namespace for one request and checks owner and inventory state again. The executor proves the namespace before and after reading the page.

Input is `{ query?: { limit?: number, cursor?: string } }`. The limit is an integer from 10 to 200, default 50. A cursor is at most 2,048 characters and cannot contain control characters. Inputs cannot select an account, namespace, URL or request headers.

The existing `provider-read` result has `data.name`, `data.records` and `data.pagination`. Records contain a 64-character hexadecimal instance `id` and, when supplied by Cloudflare, boolean `hasStoredData`. Other provider fields are excluded. Pagination contains the requested `limit`, returned `count`, `nextCursor` and `hasMore`. An omitted provider cursor gives `hasMore: null`, meaning completeness is unknown. An explicit empty cursor gives `false`. A nonempty cursor gives `true`. Repeated cursors, duplicate IDs, inconsistent counts and pages larger than requested are rejected, not truncated. The existing eight-second fetch timeout, 256 KiB response bound, fixed API origin and redirect refusal apply.

The fixture is the complete pinned operation artifact, SHA-256 `45b848ff88555e1a788d43874865c500db4c1ab5b5b4b6c7ec2b9decb53e854b`, from Cloudflare OpenAPI revision `9a5e4d44bd74d90fa9e4822142b8eb67e4ba3c70`. The [official operation documentation](https://developers.cloudflare.com/api/resources/durable_objects/subresources/namespaces/subresources/objects/methods/list/) was checked against it.

Verification: 236 tests passed across the provider adapters, ownership resolver and runtime routes, including real local Workerd database regressions. After the final pre-proof authorization check, all 41 operation-route tests passed again. The complete package typecheck passed 20/20 and scoped type-aware lint passed. The isolated worktree required normal `prepareProject` generation of ignored `.bwf` files before typechecking. No deployment or live provider request was made, and the full monorepo suite was not repeated for this slice.

This is an instance inventory operation. It does not read application records inside an instance, report memory/health, restart an object, or grant write access. Dashboard composition uses the returned schema and existing generic projections; there is no product-specific UI.
