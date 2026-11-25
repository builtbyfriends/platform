# Operation catalog candidate

This source-only backport starts at `53e3ee2e25455fb8a16cf2cd7c93f0990f73d5f6`, the API source verified against the active `52b7eed8-b5c0-4e4c-b72a-41acda73ffb2` build on November 25, 2026. It has not been uploaded or activated.

It adds authenticated `POST /app-billing/projects.capabilities` discovery, using the existing connected-app ownership and preview checks. The catalog uses the pinned Cloudflare CLI `1.0.0-rc.2` snapshot, schema `1.0`, SHA-256 `d399ac23573b5ac40f0ae7ad1752a5be036429e239de176af85cde4693498f2d`. The snapshot contains 2,947 operation summaries. These summaries do not grant execution access or describe complete input validation.

Executable resource descriptors come from the baseline resource inventory. Database, file, key-value and queue actions retain their existing availability checks. External database connections remain unsupported executable resources on this branch. The backport does not add Hyperdrive inspection, SQL behavior, migrations, bindings, dependency upgrades or provider execution paths.

Before any upload, verify the active API source and binding configuration again. An upload would change the shared Platform API; testing a connected application's dev environment does not make that API a separate development installation.
