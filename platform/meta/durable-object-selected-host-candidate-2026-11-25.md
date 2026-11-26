# Selected Durable Object host observation

Implemented on `codex/selected-durable-owner`, based on `a2ff89b2`. Not deployed or pushed.

Resolving one managed namespace previously inspected each eligible managed host in the project. An unrelated slow or unavailable host could therefore prevent a healthy selected resource from opening.

The selected-namespace resolver now passes its resource ID to the existing bounded observer. It reads the serving app and selected managed host only. The complete resource inventory still participates in namespace/host ambiguity detection and the final inventory comparison. Project ownership, active deployment, route, manifest, dispatch namespace and selected host markers retain their existing checks. The six-second deadline and response bounds are unchanged. Full topology requests omit the selector and retain their existing behavior.

No account-wide namespace enumeration, storage access or new operations are introduced. Repeated ownership checks around an operation still fetch fresh evidence; this change does not cache that evidence.

## Verification

- On the pinned Node 24.22.1 runtime, 183 tests passed: the complete 134-case app-runtime route suite and 49 Durable Object ownership/provider-read cases.
- The new two-host fixture declares both resources in inventory, manifest and app bindings. Its unrelated host fails if queried. Selected proof succeeds with exactly the app and selected-host requests; full topology still queries the unrelated host and reports unavailable.
- Regression cases reject duplicate host/namespace inventory and project owner, route or inventory changes during selected-host inspection. Existing namespace, dispatch, manifest and host-marker checks remain covered.
- Platform API typecheck and scoped typed lint passed. Formatting and whitespace checks passed.
- The broader affected run used Node 26 before the pinned runtime was found: 5,034 tests passed, 29 failed, 25 skipped; 38 files failed, including import/setup failures. Missing generated dashboard configuration, admin browser assets and public CLI/package builds explain several failures. A Workerd test that timed out in that run passed in the final Node 24 route suite. This broader run is not acceptance evidence.
- Workspace `vp run check` stopped on missing generated `playground/pg-api-test/.bwf/tsconfig.json` and its `@schema` types. The full monorepo suite was not run after those setup failures; unrelated generated build preparation remains outside this slice.

Detailed local logs are under `.local-runtime/selected-host/` in the isolated implementation worktree. No credentials, live state, worker traffic, dependencies or lockfiles changed.
