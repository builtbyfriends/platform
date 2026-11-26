# Reviewed provider configuration writes

Implemented on `codex/reviewed-provider-writes`, based on `10e8905c` (the structured reads integrated into the primary branch as `4783c411`). No deployment, provider mutation, or UI acceptance has been performed.

The shared operation registry now registers approved provider configuration writes from pinned schemas. The first policy is `r2-put-bucket-cors-policy`, paired with the existing CORS GET. The PUT fixture uses pinned artifact SHA `53ef1d1e70284f156ebc48961e5619c7ee8d95b24a88ef7c05a892402cb2b16d`; the runtime loader verifies the pinned compressed size, decompressed size and hash. No resource inventory or ownership scope is widened.

The descriptor has effect `write` and accepts `{ body, expected }`. Both are bounded nested configuration objects derived from the pinned schema and an explicit approved field selection. `body.rules` is required; `expected` is the opened read snapshot with the display `name` omitted. Missing fields remain missing and an empty rules list remains empty. The generic UI must bind `expected` to that opened snapshot, rather than asking the user to fill it in or deriving it from the proposed body. The existing route enforces descriptor version, effect, tenant ownership and reviewed confirmation before invocation.

The executor reads current configuration, compares it with `expected`, checks authorization again, sends one PUT, and reads the result back. Account, bucket and jurisdiction come from the selected owned resource. Unknown inputs, extra paths/headers, private/read-only fields, unsupported methods and changed schema pairings fail closed. Write preflight and verification reads reject configuration fields outside the approved projection; a replacement cannot silently erase a setting omitted by the generated view. Existing ordinary read projection behavior and descriptor versions remain unchanged.

The response uses the existing receipt conventions: `provider-write` includes observed data, while `conflict`, `unavailable` and `unknown` include a reason with no data. A stale opened snapshot stops before PUT. Transport ambiguity, invalid success responses, a failed/mismatching readback, or ownership loss after submission produces `unknown`. No automatic write retry or compensating rollback is attempted.

This is not atomic compare-and-swap. The pinned PUT operation has no conditional-write header. A different client may change the provider configuration between preflight and PUT, or immediately after verification. The descriptor explains the replacement semantics and this limitation. Unsupported products, arbitrary catalog operations, provisioning/deletion and child-resource traversal remain outside this slice.

## Verification

- 156 tests passed across six focused files: provider writes, provider metadata reads, structured reads, Durable Object reads, Hyperdrive reads and the complete runtime operation route suite. This includes 35 new write-unit cases and eight new route cases. The first sandboxed route run passed 60 tests and failed only because Workerd could not bind localhost; the final complete focused run passed with localhost permission.
- Cases cover nested generated input/output, required review, descriptor/effect mismatch, tenant and provider-scope overrides, stale comparison, omitted versus empty fields, ownership changes, field-schema annotations, unknown configuration fields, projection limits, rejected and uncertain provider responses, failed readback, no retry, and independent availability when a pinned artifact is damaged.
- API TypeScript checking and scoped type-aware lint passed. Formatting and whitespace checks passed.
- Input projection permits at most eight levels, 200 items per array, 4,096 values per snapshot, 16,384 characters per string and 128 KiB for the combined serialized input. Reads retain the 256 KiB provider-body and eight-second request limits. Responses over these bounds fail rather than silently truncating a configuration.
- The conservative affected-test list is recorded locally. The broader workspace check/full suite was not repeated: prior runs have unrelated missing generated playground configuration and Workerd/admin setup failures. Parent requested focused security/integration coverage and reuse of unchanged evidence.

Logs are under `.local-runtime/provider-write-*`. Live acceptance and generic editor binding are pending integration in Crowded.
