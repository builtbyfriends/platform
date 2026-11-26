# Reviewed provider configuration writes

Implemented on `codex/reviewed-provider-writes`, based on `10e8905c` (the structured reads integrated into the primary branch as `4783c411`), and integrated as `ce818e14`. The approved Platform API version is live. Customer configuration writes and authenticated UI acceptance remain unverified.

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

Logs are under `.local-runtime/provider-write-*`.

## Approved activation — 2026-11-26

The owner approved version `e5603e1f-0538-4377-98c0-c9868cfea949`. It was activated on `platform-main-api` at 100% traffic in deployment `74212e99-d824-463a-819c-747c21b62cae`; verification completed at `2026-11-26T04:28:32.089Z`.

- Source: `ce818e14ec9d61a8713c4146fd34e0b15b106d77`.
- Bundle SHA-256: `fe06dc0463001fe775d68e28b2eb70e8d1635ed7f30663a3ecd5ef0f28c52e99` (4,051,170 bytes).
- Previous live version: `92cdf550-6ef4-49f4-aac6-283c955aef97`, deployment `4416d3dd-f383-458c-8bd0-d93352450ffa`.
- Before activation, the helper checked the expected live deployment, both version sources and settings, then checked the deployment and settings again before switching traffic. After activation, it verified the exact candidate source and active deployment.
- All 63 bindings and existing configuration were preserved. No migrations were included. `/health` returned 200 with status `ok`.
- Unauthenticated calls to `projects.capabilities`, `projects.resourceOperations`, `resources.invoke`, `projects.resources`, `resources.inspect` and `resources.execute` returned 401.
- The scope audit confirmed that current R2 provisioning creates a dedicated bucket per project and binding. `PLATFORM_PROXY` mediates access to that bucket; it does not register shared prefix storage as a project resource.

The candidate retains the verified live API baseline plus the scoped infrastructure changes. It does not claim parity with Platform main: at preparation, `origin/main` was `e22d31b1`, with 157 commits absent from this branch, including unrelated migrations. Those changes were not included in this shared API activation.

Authenticated UI acceptance is pending. Crowded dev was replaced at `2026-11-26T04:30:39Z` by version `99e5f2b4-9384-4ba7-a22e-6247d28dbadb`, removing the feature endpoints needed for the test. A successful main build from `e7af3d1ef143d4a55d2314a0c5182c6387ee1aa9` overlaps that deployment; Cloudflare did not expose an exact version-to-commit association. No customer R2 configuration mutation was performed during deployment verification.

Local receipt: `.local-runtime/reviewed-provider-candidate/activation-verified.json`.
