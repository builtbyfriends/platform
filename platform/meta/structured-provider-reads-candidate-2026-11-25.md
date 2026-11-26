# Structured provider reads

Implemented on `codex/structured-provider-reads`, based on `9565b772`. Not deployed.

The shared provider adapter can now project explicitly selected nested objects, arrays and scalar leaves. It derives their output schema from the pinned provider document. Unknown fields are omitted, approved fields that become write-only or cease to be scalar stop preparation, and objects reject unsafe property names. Existing scalar metadata descriptors retain their versions.

The first operation using this path is the pinned R2 bucket CORS read. It returns rule IDs, allowed headers/methods/origins, exposed headers and maximum age. The account, bucket and jurisdiction come from the selected owned resource. As with the managed-domain read, the configuration response does not echo a comparable bucket identity; the injected owned URL and fresh ownership checks before and after the read establish scope. This introduces no provider write and no product-specific dashboard.

Projection limits are eight selection levels, 200 items per array, 4,096 values, 16,384 characters per string and 128 KiB for the serialized result. The existing 256 KiB provider-body bound and eight-second timeout remain. Exceeding a bound fails the operation; no partial configuration is presented as complete. Empty lists stay empty, missing optional values stay absent, and zero stays numeric. Configuration lists have no invented cursor or pagination controls.

## Verification

- On Node 24.22.1, 113 distinct provider/runtime tests pass across the final source results: the complete operation-route file and the provider metadata, structured response, Durable Object and Hyperdrive unit files. The first combined run passed 112 and exposed one older test assuming CORS was unregistered. That negative now uses an unregistered path and also checks rejection of a mismatched CORS document; its complete 18-test file passed again.
- Six new route cases exercise schema discovery, invocation alongside existing operations, scope/effect/version/pagination rejection, owner/bucket/jurisdiction changes during the request and safe failure when item bounds are exceeded.
- Sixteen new unit cases cover nested output, valid empty/missing fields, zero, pinned-schema violations, item/string/value/byte bounds, omission of unknown fields, write-only/type changes and ownership checks.
- API typecheck, scoped typed lint, formatting and whitespace checks passed. The CORS gzip is copied from the existing pinned artifacts and checked against the runtime loader's size/hash validation by the integration suite.
- Local logs and an exported adapter descriptor are under `.local-runtime/`. The full workspace suite was not repeated: the previous run remains blocked by missing generated playground configuration, and the broader affected run has no successful terminal summary.

This slice supports explicitly selected object/array structures and primitive leaves. It does not infer safe fields from an arbitrary provider schema, enable other products, execute provider writes, add general child-resource path selection, or replace the existing Durable Object pagination adapter. Live acceptance and generated component review remain pending integration.
