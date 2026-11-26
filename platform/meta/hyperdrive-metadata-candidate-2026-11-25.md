# Owned database connection metadata candidate

Status: implemented and checked on a feature branch. Not merged or deployed.

Connected applications can discover and run a read for an owned Hyperdrive database connection through the existing `projects.resourceOperations` and `resources.invoke` routes. The operation uses the pinned Cloudflare GET schema and the shared provider executor. No API request shape, migration, binding or dependency changes are needed.

The result exposes cache settings, connection limit, creation/change/restart times, and TLS mode when returned by the provider. It uses the application's resource label. Origin host, database name, username, passwords, Access credentials, integration details, certificate identifiers and provider resource identifiers are excluded. Missing credentials or missing/corrupted schema assets make the operation unavailable. Provider permission errors return a sanitized failure rather than diagnostic data.

The schema normalizer now handles output-only interpretation of required write-only properties inherited through `allOf`. A GET response need not contain the database password; write-only credentials returned in a matching schema branch are rejected. Unrecognized fields permitted by the provider schema still cannot pass the separate output allowlist. Schema traversal remains bounded.

This does not add SQL access, connection changes, restart actions or new provisioning. It does not make Containers or Durable Objects executable through this adapter. The current custom Durable Object resource record holds a dispatch Worker identity rather than a namespace ID. Container application ownership must be connected to the authoritative deployment records before advertising provider reads; the resource type alone is insufficient.

Validation uses the real pinned Hyperdrive document. Unit and API integration coverage checks discovery and invocation through the same registry, response redaction, inherited write-only fields, wrong owner/resource, changed ownership, missing/corrupted schemas, missing credentials and sanitized provider permission failures. Existing D1, R2, KV and Queue descriptor versions are unchanged. Focused checks and workspace types passed; the prior base branch broad run was reused, and the affected selector's broader Platform suite was not repeated for this slice.
