# Cloudflare OpenAPI artifacts

This is a build-time compiler for a pinned Cloudflare OpenAPI 3.0.3 JSON source. It does not grant execution permissions or call Cloudflare APIs.

```sh
node scripts/cloudflare-openapi.mjs /tmp/cloudflare-openapi.json <40-character-git-revision> /tmp/new-artifact-directory - platform/packages/api/src/infrastructure/cloudflare-openapi-snapshot.ts
```

Use a new artifact directory. The fourth argument can be a JSON array of `{ "method": "GET", "path": "/accounts/{account_id}/..." }` selections; `-` selects the source's operations. Omitting the output directory measures extraction without writing artifacts.

The script writes:

- `<sha256>.json.gz`: an operation document with its path parameters, request and response media, constraints, security schemes, and reachable components. References stay references, including cycles.
- `index.json`: exact source revision and SHA-256, coverage counts, operation metadata, artifact hashes and compressed/uncompressed sizes, and excluded operations with reasons.
- The optional TypeScript snapshot: source provenance and a gzip index containing operation IDs, methods, paths, summaries, tags, deprecation flags, artifact hashes and sizes. It does not embed the operation schemas.

The source read is limited to 64 MiB and an extracted document to 1 MiB. Artifact filenames come from content hashes, not operation IDs or paths. Existing artifacts are not overwritten. An extraction failure is recorded and causes CLI exit status 1; inspect the exclusion report before accepting a snapshot. Duplicate operation IDs abort compilation.

The compiler preserves local component references, including pointers into components, and discriminator mappings. It rejects missing, external and non-component references instead of silently dropping constraints. Example/default payloads are kept as data. The global `x-forge-commands` navigation extension is omitted. Referenced security schemes must exist in the source; the compiler does not invent missing schemes.

For serving, store the gzip documents under an immutable prefix such as `infrastructure/cloudflare-openapi/<source-sha256>/`. Bundle the small snapshot index. An authenticated reader can select a catalog entry, fetch its hash-named artifact, bound decompression, verify its length and SHA-256, and return that one document. Catalog presence does not authorize the underlying operation; tenant ownership and permitted execution still need separate checks.

Exports for build tooling are `indexCloudflareOperations(document)`, `extractCloudflareOperation(document, { method, path })`, `buildCloudflareCatalog({ sourcePath, revision, outputDirectory?, selections? })`, and `writeCloudflareSnapshot(report, destination)`. Extraction returns `{ document, metadata }` with `execution: 'discovery-only'`.

Run the focused checks with `node scripts/cloudflare-openapi.test.mjs`. The Platform unit suite also invokes them.

## Publish the pinned artifacts

First validate the generated directory against the committed snapshot, without credentials or network requests:

```sh
node scripts/publish-cloudflare-openapi.mjs /tmp/new-artifact-directory <existing-static-assets-bucket> --dry-run
```

When authorized to publish, provide `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` through the deployment environment, then use the same command with `--publish`. The token needs write access to the existing bucket used by `STATIC_ASSETS_R2`. The script does not create buckets, change bindings, delete objects or activate a Worker version.

Publication checks the source revision/hash and the exact operation index against the committed snapshot. Before sending a request, it checks the complete artifact set: safe filenames, regular files, bounded decompression, sizes, operation identity and SHA-256. It then uploads the verified buffers to `infrastructure/cloudflare-openapi/<source-sha256>/<artifact-sha256>.json.gz`. The compressed set is limited to 64 MiB.

The publisher uses Cloudflare's [R2 object upload API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/upload/), also used by Wrangler. It fixes the API origin, refuses redirects and preserves literal key separators while encoding each segment. This avoids a CLI process per object and the installed Wrangler bulk command's experimental catalog override. The Basin Catalog protection header stays enabled.

Uploads run four at a time. Rate limits and transient failures receive up to four attempts, honoring `Retry-After` with a five-minute maximum wait. Authentication/permission errors stop new work. A CLI rerun reuploads the same verified content to the same keys, so a partial run can be repeated without deleting anything. The exported `publishCloudflareArtifacts` function also accepts `skipKeys`: a unique array of keys from the verified artifact set. The caller must first verify those remote objects against local content, such as through size and a single-part upload's MD5 ETag. Reports count `skipped` and `uploaded` separately; progress counts only pending uploads. Cloudflare rate limits can make a full publication take several minutes. Logs contain counts and HTTP status codes, not credentials or response bodies.

Objects are stored as `application/gzip`, without an HTTP `Content-Encoding` setting. The runtime reader receives the compressed bytes and performs its own bounded verification. Publication success confirms the PUT responses; runtime retrieval should also be checked before activating a Worker that needs the new snapshot.

Run mocked publication checks with `node scripts/publish-cloudflare-openapi.test.mjs`. These tests do not upload objects.

## Discovery and coverage maintenance

The authenticated `POST /app-billing/projects.capabilities` endpoint joins the pinned OpenAPI index to CLI commands by method and path. Operation IDs in list results are canonical OpenAPI IDs. Earlier CLI IDs remain accepted aliases for complete-schema lookup; they aren't executable registry IDs. Operations without CLI commands are included. Product groups use the CLI product when known and the first non-parameter API path segment after accounts/zones otherwise. These groups organize discovery; they aren't a list of supported resource kinds.

Use `query` (up to 200 characters) and optional `method` to search summaries, tags, IDs, aliases, paths and commands, within a `product` or across products. Tokens match case-insensitively. Without a product, query or method the endpoint lists product groups. Pages contain at most 50 summaries and 32 KiB of operation metadata. Cursors pin the project, resource, normalized query, method, product and both artifact digests. A changed search or snapshot requires starting a new page sequence.

A summary provides `schemaSha256`; pass it with `operationId` to fetch one complete document. A changed digest returns 409 `operation_schema_changed`. API-only entries don't invent CLI commands, field lists or request-body knowledge: fetch the full document before composing inputs. Field summaries can be truncated; they don't replace schema validation.

A selected owned resource can provide a `registeredOperation` reference with its exact executable ID/version/effect. Discovery-only entries instead state `unavailableReason`: resource not selected, resource no longer active, policy not installed, installation not configured, provider identity unavailable, schema unavailable, or schema incompatible. Registration still isn't proof of successful execution on a target. Invocation rechecks ownership, version, effect, inputs and applicable provider limits. This catalog change doesn't alter executable descriptor IDs or version hashes.

Generate an offline per-operation and per-family coverage report:

```sh
node scripts/check-cloudflare-catalog.mjs > /tmp/catalog-before.json
```

After compiling a proposed artifact update in an isolated branch, compare it with that report:

```sh
node scripts/check-cloudflare-catalog.mjs /tmp/catalog-before.json > /tmp/catalog-after.json
```

The checker verifies the pinned indexes, detects an effective installed CLI version/hash mismatch when the package is available, and fails if an installed provider policy has no pinned schema. Comparison reports added, removed and changed operations, including schema hashes and aliases; differences exit with status 1 for review. No artifact update, network request, publication or deployment occurs. Review the diff, affected operation tests and source exclusions before committing new pins. The publisher's dry-run separately verifies the complete artifact directory against the updated snapshot.

The report distinguishes discovery, installed provider/proxy policies, target-dependent execution, and live/UI acceptance. Live and UI acceptance are `not-recorded`; tests and artifact counts don't become production acceptance. Existing test-session observations still need their deployment/operation versions attached in the project coverage record.

Current baseline: effective `cf` 1.0.0-rc.2, 2,947 CLI aliases over 2,944 unique endpoints, 3,944 extracted OpenAPI operations from revision `9a5e4d44bd74d90fa9e4822142b8eb67e4ba3c70`, and 1,000 API-only entries. Four source operations are excluded because their referenced security schemes are missing; the generated report retains their reasons. Twelve provider policies and three proxy operations are installed in source. These counts don't claim broad Cloudflare product execution or live acceptance.

Run `node scripts/check-cloudflare-catalog.test.mjs` for coverage/drift regressions. Changing catalog metadata alone must preserve saved executable versions; existing operation tests cover stale-version rejection.
