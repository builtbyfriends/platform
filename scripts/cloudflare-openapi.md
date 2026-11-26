# Cloudflare OpenAPI artifacts

This is a build-time compiler for a pinned Cloudflare OpenAPI 3.0.3 JSON source. It does not grant execution permissions or call Cloudflare APIs.

```sh
node scripts/cloudflare-openapi.mjs /tmp/cloudflare-openapi.json <40-character-git-revision> /tmp/new-artifact-directory - platform/packages/api/src/infrastructure/cloudflare-openapi-snapshot.ts
```

Use a new artifact directory. The fourth argument can be a JSON array of `{ "method": "GET", "path": "/accounts/{account_id}/..." }` selections; `-` selects the source's operations. Omitting the output directory measures extraction without writing artifacts.

The script writes:

- `<sha256>.json.gz`: an operation document with its path parameters, request and response media, constraints, security schemes, and reachable components. References stay references, including cycles.
- `index.json`: exact source revision and SHA-256, coverage counts, operation metadata, artifact hashes and compressed/uncompressed sizes, and excluded operations with reasons.
- The optional TypeScript snapshot: source provenance and a gzip index containing only operation IDs, methods, paths, artifact hashes and sizes. It does not embed the operation schemas.

The source read is limited to 64 MiB and an extracted document to 1 MiB. Artifact filenames come from content hashes, not operation IDs or paths. Existing artifacts are not overwritten. An extraction failure is recorded and causes CLI exit status 1; inspect the exclusion report before accepting a snapshot. Duplicate operation IDs abort compilation.

The compiler preserves local component references, including pointers into components, and discriminator mappings. It rejects missing, external and non-component references instead of silently dropping constraints. Example/default payloads are kept as data. The global `x-forge-commands` navigation extension is omitted. Referenced security schemes must exist in the source; the compiler does not invent missing schemes.

For serving, store the gzip documents under an immutable prefix such as `infrastructure/cloudflare-openapi/<source-sha256>/`. Bundle the small snapshot index. An authenticated reader can select a catalog entry, fetch its hash-named artifact, bound decompression, verify its length and SHA-256, and return that one document. Catalog presence does not authorize the underlying operation; tenant ownership and permitted execution still need separate checks.

Exports for build tooling are `indexCloudflareOperations(document)`, `extractCloudflareOperation(document, { method, path })`, `buildCloudflareCatalog({ sourcePath, revision, outputDirectory?, selections? })`, and `writeCloudflareSnapshot(report, destination)`. Extraction returns `{ document, metadata }` with `execution: 'discovery-only'`.

Run the focused checks with `node scripts/cloudflare-openapi.test.mjs`. The Platform unit suite also invokes them.
