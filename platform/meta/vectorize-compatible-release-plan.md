# Managed Vectorize compatibility release

Prepared 2026-11-25. This is a release plan, not a deployment receipt. No live index,
credential, installation, customer data or billing setting was changed for this plan.

## Candidate and installed baseline

The candidate branch starts at `89405e3` (the installed runtime maintenance branch).
It includes the prior Activity, database, queue and index-inspection API patches.
The last recorded API deployment is source `ec84419`, version
`25e71594-d48c-4394-8e60-83f8b1139378`, deployment
`82daf8fd-7c93-4aff-a48c-3459a90c9e2c`; its receipt records 63 preserved bindings.
Re-read live versions and settings before preparing an upgrade.

The installation is `main-895b05ab5ed1`, endpoint
`https://platform.buildwithfriends.dev`, API Worker `platform-main-api`.
Its saved installer checkpoint reports Platform `1.9.4`, original runtime revision
`192e281e5f8c745e2b2c4b6737f6ed0c7a5a27c0`, and schema digest
`fc9f6baf6134204b8ea7d726617d860eb2460ca644e116ecea40d6db4174546d`.
That checkpoint predates the API-only patches; it is not evidence of the current
Worker code. Keep both the installer checkpoint and subsequent receipts.

The historical journal has 64 entries, ending at `0070_app_github_installations`.
Its entries and migration SQL match the first 64 entries of the forward branch.
Vectorize needs no SQL migration: resource types are stored as text. Keep this
journal, SQL and compatibility declarations unchanged. The forward branch's 21
later migrations are unrelated and are excluded from this release.

## Coordinated artifact scope

| Layer             | Change                                                                                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| deploy-core       | Manifest v6, validated Vectorize declarations, resource plan.                                                                                                                    |
| deploy-cloudflare | Typed index operations used by native deployments.                                                                                                                               |
| bwf               | Config and generated types, compiler output, managed capability gate, native provisioning, explicit unsupported preview/local paths.                                             |
| platform package  | Optional installation capability, runtime `vectorize: 1` marker, installer negotiation, token preflight and downgrade guard.                                                     |
| Platform API      | Tenant-owned create/reuse/cleanup, binding upload, admission checks, inventory and bounded info/query actions.                                                                   |
| Packaged runtime  | Rebuild the API, proxy, dispatch, tail and email-gateway artifacts, admin assets and manifest from this same historical candidate. Keep unchanged services on historical source. |

This is not an API-only upload. Public SDK and runtime must agree on manifest v6
and the negotiated capability. The CLI refuses managed Vectorize on installations
that do not advertise support. Do not relabel an old artifact as compatible.

The historical schema has owner suspension on `users`, not the newer
`projects.suspended_reason`. The backport checks the owner before runtime actions,
again before returning results, and under a shared owner-row lock in both
provisioning transactions. It uses the historical suspension policy rather than
adding the unrelated project-suspension migration. Tests use the historical
`app:` identity convention; no newer app-credit module is imported.

## Candidate verification

The final coordinated core build passed all eight tasks. SDK typechecks passed
all six tasks; Platform typechecks passed all seven. The API's 172 focused tests
and the SDK's 277 focused tests passed. Scoped SDK/API lint and diff checks passed.
API cases cover suspended-owner inventory/actions/provisioning with no provider
call, suspension during a read, and publish/redeploy/failed-upload index retention.

The changed-file selector required the full 713-file suite. Its first run passed
696 files, skipped one, and failed 16 because child processes could not find
`vp` on PATH. Those exact 16 files passed on rerun (96 tests) with the repository
binary directory on PATH. No product or test code changed to hide that failure.
Combined coverage is 712 passing files and one skipped file. The runner was
invoked directly with Node and without NODE_PATH so package-wrapper injection
could not affect temporary app dependency resolution.

Local evidence is under `.local/vectorize/`: `build-core-final.log`,
`types-sdk-final.log`, `types-platform-final.log`, `regression.log`,
`lint-all.log`, `affected-list.log`, `full.log` and
`full-failed-rerun.log`. These logs are local evidence, not shipped artifacts.

The preparation runtime has exactly the installed schema digest above, 64
migrations and `vectorize: 1`. The six public package manifests remain at 1.9.4;
no version was reserved or published. Rebuild from the committed candidate before
selecting and packaging the release version.

## Read-only installation comparison

On 2026-11-25, remote discovery recovered the existing installation using the
existing Cloudflare CLI login. It wrote only a candidate-local registry; it did
not change login scopes or live configuration. The normal `upgrade --plan`
stopped because local recovery state lacks the original PostgreSQL database URL.
It requires `PLATFORM_DATABASE_URL` for that existing installation. This remains
a release blocker; the configuration inventory below does not replace the plan.

At 12:14:41 UTC, fresh Worker metadata still matched the API version and deployment
above. Binding names, types and resource targets matched the generated candidate:

| Worker | Generated bindings | Inherited secrets | Live total |
| --- | ---: | ---: | ---: |
| API | 42 | 21 | 63 |
| Dispatch | 15 | 0 | 15 |
| Email gateway | 8 | 0 | 8 |
| Proxy | 10 | 3 | 13 |
| Tail | 3 | 0 | 3 |

The only binding-value change is the intended Vectorize capability in
`PLATFORM_CAPABILITIES` on API, proxy and email gateway. Routes, custom domains,
workers.dev/preview settings, cron schedules, queue consumers and workflows
matched on all five Workers. Active deployments were rechecked after the reads.
No credential values are included in this document.

Raw settings are not byte-for-byte equal: Cloudflare returns expanded
observability defaults where the generator emits `{ enabled: true }`, empty
placement objects where the generator omits placement, and empty compatibility
flag arrays where it omits flags. The historical configuration generator is
unchanged for these settings. Review those default-shape differences in the
normal installer plan before application; this inventory does not prove that an
upload preserves an undocumented provider default. Local
`config-comparison.json` records hashes and counts; restricted local snapshots
retain the detailed comparison without committing settings or secret values.

## Checks before a live upgrade

1. Finish the focused SDK/API backport checks, typechecks, builds and release
   tests. Record exact source revision and artifact hashes. Build from a clean
   committed candidate; do not use a dirty source revision as a release receipt.
2. Compare the generated runtime manifest with the installed checkpoint. Require
   the unchanged 64 migration entries and schema digest, plus the new Vectorize
   protocol marker. The installer retains its normal migration and ownership checks.
3. Refresh remote installation discovery and read the active code/settings for
   each installer-owned Worker. Save metadata and hashes without secret values.
4. Compare generated Worker configuration with that live snapshot, by binding
   name and type: service targets, namespaces, database/bucket/queue IDs,
   Hyperdrive, Durable Object classes, dispatch namespaces and analytics bindings.
   Compare plain vars, routes, custom domains, triggers, compatibility settings,
   exports, placement, observability, limits and tail consumers too. Existing
   secrets must be inherited. The intended capability addition is explicit;
   unexplained dropped bindings or altered values block application.
5. Run the normal installer plan against this candidate. Its outside-change
   report is expected to notice the API-only patches. Review the real differences
   before accepting them. `--plan` does not read PostgreSQL because it has no
   lifecycle lock; it does not prove that the database needs zero migrations.
6. Verify the actual runtime token's account scope and Vectorize Edit permission.
   A successful index-list preflight proves read access only. Management-browser
   login does not prove the Worker token can create an index. Keep credentials out
   of the receipt; change none merely to complete these checks.

Build and read-only plan commands, from the candidate checkout:

```sh
vp run build:core
node packages/bwf/dist/cli/cli.mjs platform upgrade main-895b05ab5ed1 \
  --runtime packages/platform/dist/runtime --plan
```

Use the installer upgrade path for the eventual application, preserving its
locks, ownership review, migration checks, saved secrets, health checks and
recovery record. The legacy hosted `platform-deploy.yml`/`prod` workflow targets
different resources and is not the installation upgrade command.

## Publication and acceptance

All six public packages must share the release version: bwf, create-bwf,
deploy-core, deploy-cloudflare, edge and platform. The current source version is
1.9.4. Registry reads on 2026-11-25 found no 1.9.5 for bwf, platform, deploy-core
or deploy-cloudflare; verify all packages again before choosing a version.
Nothing reserves that version.

The `vX.Y.Z` publication workflow runs release policy, CI, Platform schema
compatibility and packed tests, then uses the Release environment and npm trusted
publishing. Establish the actual immutable production baseline for the schema
job: its current default reads the GitHub `Prod` deployment history, which may
describe the legacy hosted platform. A read-only check found no `Prod`
deployments and no `PLATFORM_PRODUCTION_REF` or `PLATFORM_PRODUCTION_ENV`
repository variable. The job already maps those variables to its resolver;
set an immutable verified baseline rather than inventing a deployment receipt.
Confirm trusted publishing for the actual repository;
older operations prose still names the upstream repository.

Upgrade the compatible runtime before publishing the SDK, per repository release
policy. Check health, unauthenticated denial, capability response and exact final
configuration. Retain the prior runtime and version receipts. The new installer
refuses downgrading an enabled Vectorize installation to a runtime without its
protocol; do not promise an unrestricted old-version rollback after adoption.

Live acceptance is a separate authorized published-app test: create one owned
index, use the real application binding, inspect info/query through the app,
redeploy without losing the index, and verify failed deployments preserve it.
Private previews remain unsupported. No payment-plan or AI-credit bypass is part
of this release, and no live index has been created by this plan.

References: [source runtime upgrades](../../docs/guide/platform/development/runtime.md),
[installer maintenance](../../docs/guide/platform/installation/maintenance.md),
[credentials](../../docs/guide/platform/installation/credentials.md),
[Cloudflare index creation](https://developers.cloudflare.com/api/resources/vectorize/subresources/indexes/methods/create/).
