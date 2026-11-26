# Provider catalog ownership consistency

The selected-resource provider catalog now uses the same owned-resource caller as executable resource discovery and invocation. A managed Durable Object's object-list entry is marked registered only after its namespace is proven from the active app and host bindings. The catalog repeats the proof before returning an executable hint.

The shared caller keeps the project/deployment checks and compares resource ID, project, type, provider identity, binding name, jurisdiction, namespace, and dispatch namespace. A changed proof returns `resource_changed`. Missing or ambiguous ownership leaves the provider entry discovery-only. Full OpenAPI document requests and product browsing without a selected resource remain discovery-only.

The response contains the app's resource ID, registered operation ID, version, and effect. The selected Cloudflare namespace and managed host name stay internal. Caller-supplied namespace overrides are rejected.

This is source work on `codex/catalog-owned-capabilities`, based on `6cbcd7fa`. No deployment or source push was performed.

## Verification

Using Node 24.22.1, the catalog and operation route suites passed 73 tests. Scoped lint, the API typecheck, and all 20 workspace typecheck tasks passed. The affected-test selector listed 241 files; that broad selection was not rerun for this route-only change. The checked base's broader evidence remains applicable to unchanged source. Logs are kept locally in the ignored `.tmp-catalog-checks/` directory.

The route regressions compare both catalogs' registered operation ID and version, reject stale or ambiguous ownership, detect namespace and deployment changes during the final proof, reject caller-supplied namespace IDs, and retain discovery-only schema retrieval.
