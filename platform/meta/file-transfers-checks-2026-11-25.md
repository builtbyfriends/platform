# Infrastructure file transfers

Prepared on 2026-11-25 from the installed runtime maintenance baseline `89405e3`.
This is implementation and check evidence, not a deployment receipt.

The API adds authenticated `GET` and `PUT` at
`/app-billing/resources.files`. The connected app supplies its existing server-side
credentials and the project, resource, owner and file key. Customers receive no
provider credentials, bucket identifiers or signed provider URLs.

Downloads stream original bytes with private attachment headers. They reuse the
existing stream guard to check access between delivered chunks and while idle.
Uploads accept at most 5 MiB of measured bytes, including empty and binary files.
The API buffers that bounded upload and converts it to the existing proxy's
base64 protocol, below its 8 MiB JSON limit. The native conditional write uses
`etagDoesNotMatch: '*'`: an existing key returns a conflict instead of being
replaced. An old deployment without conditional-write support returns unavailable;
there is no unconditional fallback. An unconfirmed write returns unknown and
must not be retried automatically.

Checks cover connected-app and resource ownership, administrator suspension,
active/expired private previews, resource changes during transfers, cancellation
before dispatch, streaming revocation, path validation, measured size limits,
exact binary bytes, empty files, duplicate paths and uncertain provider replies.
The 39 transfer integration tests pass. The existing 52 runtime integration tests
also pass. API typecheck, scoped lint and diff checks pass. No live customer files
were read or written for these tests.

Only API route source and its tests change. The API imports the existing pure
stream guard from proxy source; proxy behavior, SDK source, schema, bindings and
installation capabilities remain unchanged. No Vectorize activation is included.

The prepared local maintenance commands follow the prior database-indexes release:

```sh
node .local/file-transfers/build-api.mjs
node .local/file-transfers/read-current.mjs
```

The build requires a clean source commit. The read-only live check must match the
recorded baseline version `25e71594-d48c-4394-8e60-83f8b1139378`, deployment
`82daf8fd-7c93-4aff-a48c-3459a90c9e2c`, exact code and settings, and 63 bindings.
A change to that baseline stops the release. Upload/activation remains a separate
authorized step through the existing guarded maintenance script; no full Platform
installer or npm publication is part of this patch.
