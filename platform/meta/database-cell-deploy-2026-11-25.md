# Database field reader deployment

API source `fd21ad1b7996ffca9d5589b5ad9f46343ae9dee8` deployed on November 25, 2026. Version `866294a5-c76f-418c-90bc-056351532d05`, deployment `c4d99721-ca01-4725-a939-c22f94d4b0da`. Verification completed at 15:06:46 UTC.

The deployed module matches SHA-256 `9a639d75249ada7d25b7ebe9cb325745f900fda0c79d69778f6e375409f07cb7` (3,212,556 bytes). The existing 63 bindings and settings were preserved. Health and six unauthenticated route rejections passed. The compatible Crowded parser and browser reader deployed before activation. No SDK, schema, billing or capability-flag change.

Rows include bounded type/size metadata and signed 15-minute references for complete nonprotected text/integer primary keys. A field read returns up to 64 KiB, labels truncation and reads the current logical row rather than a snapshot. Unsupported keys retain previews. Values and keys are bounded before the proxy response limit; protected columns remain inaccessible.

Runtime checks passed 87/89/87 in maintenance/forward/compatible branches, with API types and scoped lint. Cases cover Unicode/BOM, exact unsafe integers and real numbers, composite/deleted keys, expired/foreign/changed references, protected fields and a 100-column/51-row transport bound. Crowded native acceptance reopened existing short rows; a live long-field request remains unverified. No running customer queue or full Cloudflare coverage is claimed.
