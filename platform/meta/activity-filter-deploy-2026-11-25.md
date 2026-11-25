# Activity filtering API deployment — 2026-11-25

The API-only maintenance patch is live. Customer Activity now excludes known internal control requests before pagination, so those requests no longer fill otherwise empty pages. Exact queue and scheduled-task relays remain visible, as do customer URLs on public hosts. Operator logs are unchanged. Customer cursors carry a filter scope; older or mismatched cursors are rejected instead of reusing their offsets against a different result set.

| Evidence            | Value                                                              |
| ------------------- | ------------------------------------------------------------------ |
| Source              | `360d23a1c6272b702c3a98bc136d89725158d820`                         |
| Worker              | `platform-main-api`                                                |
| Version             | `209e5f5d-57af-4ee0-ae3a-e64e55a67388`                             |
| Deployment          | `62efcfc3-5db5-4f06-90c0-dfee15574387`                             |
| Verified            | 2026-11-25T14:42:30.305Z                                           |
| Artifact SHA-256    | `a8cb0db9d51fd5b1a78e8b493d8d969030cf0badf89e034d0c82dcc249fbba93` |
| Previous version    | `ea914984-f326-4678-98cc-af0a631554be`                             |
| Previous deployment | `0e8fe7f3-cd4f-455e-8b98-81a173a0a742`                             |

The live code matches the reviewed artifact. Health passed; the existing 63 bindings and Worker settings are unchanged. Unauthenticated inventory, inspection, action, activity, file download and file upload requests each returned 401. No customer data was changed.

Maintenance checks passed 132 runtime/operator tests with two existing skips, API typecheck and scoped lint. The generated SQL was executed against 110 internal requests followed by 60 customer events: customer pages contained 50 and 10 events, and Newer navigation retained the original window. A focused regression checks the production query stays below the provider's 10,000-character limit. The exact predicate also passed live Analytics Engine evaluation across 12 synthetic URL cases at 14:39:02.561Z, without returning customer log fields. Predicate SHA-256: `ee7b7be7d1030f17e56aec0accde4d9c303ee58cb6a9437a9d60bce39b16969f`.

The forward port passed 77 runtime tests; unchanged operator coverage remains applicable. The compatible runtime candidate passed the same 132 maintenance checks with two existing skips. The final query-length assertion is a test-only addition, with a passing focused rerun. Native production inspection after deployment showed an empty one-hour Activity window without the previous false Older page. Wider-window native acceptance is separate.

The existing URL-parser guard still removes unusual internal URL forms after retrieval, so those forms can still shorten a page. Minimal logs without URLs remain marked partial. This patch does not promise complete logging, retention or resource-specific traces. No SDK, proxy, schema, billing or installation-capability changes are included. The compatible candidate remains unpublished, its coordinated artifact remains stale, and Vectorize is not enabled by this API deployment.

Local evidence is retained under `.local/activity-filter/` in the `codex/infra-file-transfers` worktree. To restore the recorded previous version, run from that worktree:

```sh
node .local/activity-filter/publish.mjs rollback
```

The helper checks the active version before rollback.
