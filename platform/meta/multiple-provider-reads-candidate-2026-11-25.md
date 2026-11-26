# Multiple provider reads for one resource

Implemented on `codex/multiple-provider-reads`, based on `6cbcd7fa`. Not deployed.

Resource discovery now prepares each explicit provider-read policy for the selected resource. Each operation loads its own pinned schema and keeps a distinct stable registry handler. A missing or damaged artifact omits that operation without hiding the resource's other operations. Existing metadata descriptor versions are unchanged. Schema preparation is sequential and limited to the selected resource's policies; it does not compile the full provider catalog.

R2 now has a second provider read: its managed public domain and enabled status. The exact bucket path and jurisdiction come from the owned selected resource. Because Cloudflare's response identifies the bucket by an internal ID rather than its name, this one policy uses the injected owned path and fresh ownership checks before and after the read. Existing metadata policies still require response identity equality. The domain response omits the internal bucket ID. Callers cannot supply account, bucket, path or header overrides.

## Verification

- The focused schema-backed route selection passed 17 tests, and the provider-read unit file passed 18 tests.
- The complete four affected provider/runtime files passed 91 tests outside the sandbox, including the real Workerd D1 case. The earlier sandbox run passed 90 and failed that case with `listen EPERM` on localhost.
- Tests exercise independent artifact loss/corruption, operation ID and version separation, effect and scope rejection, existing metadata version stability, managed-domain response validation, and ownership/bucket/jurisdiction changes during a request.
- API typecheck, scoped typed lint, formatting and `git diff --check` passed.
- The conservative affected selector selected 268 files. Its interrupted run has no terminal summary and includes Workerd D1 and unrelated admin-page failures; it is not passing acceptance evidence. No test process remained when verification resumed.
- Workspace typechecking stopped on the unrelated missing generated `playground/pg-api-test/.bwf/tsconfig.json` and `@schema` types. The full monorepo suite was not repeated after those setup failures.

Local evidence is in `.local-runtime/` in the implementation worktree. No bindings, migrations, credentials, dependencies, lockfiles or live traffic changed. Live provider acceptance and generated UI acceptance remain pending integration and deployment.
