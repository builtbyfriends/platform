# Runtime resource ownership and operation coverage — 2026-11-26

This is a source coverage ledger, not a live acceptance receipt. The shared Platform deployment is unchanged. Checked source5a81b0b3 is backed up remotely and uploaded as inactive candidate801cbe58; see the owned-child handoff for its exact artifact and verification receipt. The child reads in `166c8301` and the Access reference slice described here have not been activated.

## Ownership boundary

Inventory, catalog selection and invocation now share `RuntimeResourceReference` in `packages/api/src/routes/app-runtime-resource-reference.ts`. A reference comes from a server record; a model-supplied catalog ID, account ID, provider handle or product name cannot create one. Public inventory contains the opaque ID, safe name, kind and supported controls. Provider locators and proof snapshots stay on the server.

Provisioned resources keep their existing public IDs and identity checks. Project Access applications use a stable SHA-256 reference derived from installation, project and application role. Recreating the underlying application keeps that saved-view identity, but a request already using the old proof fails. A different installation produces a different reference.

Access proof requires ready installation configuration, enabled protection, a managed wildcard application, a ready project row, matching desired/effective protection, a completed reconciliation operation and no recorded error. It compares configuration revision, project generation/time, application identity/name and installation on revalidation. Shared wildcard/health applications, duplicated local roles and application IDs claimed by more than one project are withheld. Missing, invalid, reconciling or revoked state is unavailable. Project-owner resolution and suspension checks remain in place. No account-wide discovery or new credential access was added.

## Family ledger

| Family | Authoritative ownership source | Generated operation policies in this branch | Remaining limit |
| --- | --- | --- | --- |
| D1 | Project `resources` row; current project/owner and unchanged provider identity | Bounded SELECT query; projected database configuration read | No general SQL write policy in generated operations; existing database controls are separate |
| R2 | Project `resources` row; current project/owner and unchanged bucket/jurisdiction | File text read/save; projected bucket, managed-domain, CORS and custom-domain collection reads; reviewed CORS replacement; selected custom-domain detail | Child detail requires complete collection membership before/after; new child policy is source-only |
| KV | Project `resources` row; current project/owner and unchanged namespace | Projected namespace configuration and bounded key collection reads | General provider catalog operations do not become callable; existing key controls are separate |
| Queue | Project `resources` row; current project/owner and unchanged queue | Projected queue configuration, consumer collection and selected consumer detail | Child detail requires complete collection membership before/after; new child policy is source-only; existing Queue actions are separate |
| Hyperdrive | Project `resources` row; current project/owner and unchanged configuration identity | Projected configuration metadata | Connection origins, certificates and credentials stay private; no generated write policy |
| Durable Object | Project `resources` row plus verified current deployment binding/namespace proof | Bounded object collection read | Namespace proof must resolve before advertising execution; no object-content or mutation policy |
| Container | Historical project `resources` row | No generated provider policy | Historical strings do not prove a current managed application; needs a project-scoped manifest/namespace resolver |
| Project Access application | Ready `project_zero_trust` application record plus installation configuration and reconciliation proof | Discovery only; operation list is unavailable/empty and invocation is denied | Source-only ownership extension; no pinned response projection/read policy or live native acceptance yet |
| Other Cloudflare families | No installed ownership resolver in this runtime | Discovery only | A catalog entry does not establish resource ownership, execution policy, provisioning support or working UI |

The broad pinned Cloudflare catalog remains independent of these policies. Existing fixed `resources` types still govern provisioning and the older inspect/action/file routes. The reference union adds a second source of owned inventory without changing that database enum or treating a generic resource node as an execution grant.

## Verification and next acceptance

The Access catalog tests cover safe opaque inventory, catalog discovery, explicit unavailable invocation, foreign project and raw-handle selection, stable saved reference identity, installation scoping, separate public/protected roles, ambiguous/shared/missing ownership, disabled or malformed configuration and late application/generation/configuration/revocation changes. Existing runtime, file, KV, Queue and provider adapter tests check the unchanged contracts.

Before live acceptance, review and build the exact candidate with the existing child-read source, confirm the immutable child and parent schema artifacts are present, and obtain owner approval for that exact shared Platform activation. Then use a signed-in ordinary user's real owned resources and saved generated controls. Record source, deployment and native acceptance separately. No broad support claim follows from this ledger.

The next bounded execution slice is a schema-pinned, projected Access application read using this reference's injected locator and pre/post proof checks. It needs a real owned application receipt, safe fields and tests for changed account/application/generation before activation. Containers need a separate proof contract; adding a type or a name match is insufficient.
