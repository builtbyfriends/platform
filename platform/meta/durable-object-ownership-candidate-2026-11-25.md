# Managed Durable Object ownership candidate

Implemented on `codex/owned-provider-metadata`; not deployed.

The infrastructure binding observer can now confirm a managed Durable Object's connection to its serving app. Its public response contains the app resource ID and connection only. The Cloudflare namespace ID and Worker name stay internal.

The internal `resolveOwnedDurableObjectNamespace` function in `routes/app-runtime-bindings.ts` returns a namespace only when these records agree:

- The current project inventory has one managed host and namespace.
- The active deployment manifest maps the resource's class to that namespace and one app binding.
- The routed app Worker has the expected project marker and namespace binding.
- The managed host has the deterministic project/class Worker name, the expected owner marker, the active deployment release marker, and one matching class binding.
- Project ownership, deployment, route, inventory namespace metadata, and deployment manifest remain unchanged after inspection.

Missing evidence, foreign bindings, aliases, and mismatched dispatch environments leave the namespace unavailable. Requests keep the existing six-second deadline, bounded response stream, pinned Cloudflare API origin, and redirect rejection. No account-wide namespace list is needed.

This change supplies ownership evidence. It doesn't register an object-list operation or grant storage reads or writes. An operation consumer must resolve the namespace before its request and recheck the same namespace after the response before returning data. Older records without verified namespace metadata remain unavailable until deployment establishes that evidence.

Cloudflare references: [dispatch Worker bindings](https://developers.cloudflare.com/api/resources/workers_for_platforms/subresources/dispatch/subresources/namespaces/subresources/scripts/subresources/bindings/methods/get/) and [namespace object listing](https://developers.cloudflare.com/api/resources/durable_objects/subresources/namespaces/subresources/objects/methods/list/).

## Verification

- 155 tests passed: 27 namespace ownership cases and the full 128-case app runtime route file.
- Workspace typecheck: 20/20 tasks passed.
- Scoped lint, formatting, and diff checks passed.
- Affected selection expanded to 240/719 files. The full selection was not repeated for this isolated slice; the parent requested reuse of the checked base's broad evidence and focused verification.

Detailed logs are in the ignored `.tmp-provider-checks/do-*` files in the implementation worktree. No deployment, merge, or source push was performed for this change.
