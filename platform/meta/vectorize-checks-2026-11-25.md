# Managed vector search implementation checks

Checked November 25, 2026. This records source checks, not a deployment or package release.

The change adds an optional Vectorize declaration to manifest v6, owned index provisioning and native bindings, installation capability negotiation, and bounded index information/query actions. Existing apps without that declaration do not provision an index. Private previews and local emulation reject it explicitly. Dimensions and distance metric are immutable, and a missing previously provisioned index is not silently recreated.

Focused API, compiler, native deployment, installer and contract tests passed. API and four public-package typechecks, scoped lint and package builds passed. A full affected run selected 726 files: 686 passed, 39 failed and one was skipped. Failed-file reruns passed after generating missing dashboard configuration, isolating temporary Git fixtures and reducing concurrent workers. Five deployment receipts needed portable rollback commands instead of machine-specific working-directory paths; their source revisions, version IDs and artifact hashes were retained.

The final three installation-test failures were caused by the package-manager launcher injecting `NODE_PATH`. That made isolated fixtures resolve the host's installed tool instead of their synthetic executables. The same five installation tests passed with the direct Vite+ Node entry and no product or test change. This is a failed initial run followed by resolved focused reruns, not a single clean full-suite run.

Local logs: `/tmp/vectorize-affected-full.log`, `/tmp/vectorize-failed-rerun.log`, `/tmp/vectorize-product-names-final.log`, `/tmp/vectorize-init-clean-runner.log`. The direct runner command, from this checkout, is:

```sh
TMPDIR=/var/tmp node node_modules/vite-plus/bin/vp test run packages/bwf/test/integration/init-install.test.ts --maxWorkers=1
```

A separate compatible runtime candidate retains the installed schema rather than applying unrelated forward migrations. It still needs final coordinated verification, installation/configuration comparison, publication and real customer acceptance. No live vector index was created for these checks. Per-tenant vector usage metering and text embedding generation are not included.
