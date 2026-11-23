// Decision: Windows file durations measured in
// https://github.com/voidzero-dev/void/actions/runs/36572350995. Edited suites use conservative
// estimates. These values only schedule shards; each discovered test is still included.
export const integrationTimings: Readonly<Record<string, number>> = {
  'packages/bwf/test/e2e/cloudflare-deploy-live.test.ts': 6,
  'packages/bwf/test/integration/cli-help.test.ts': 1718,
  'packages/bwf/test/integration/cli-runtime-check.test.ts': 900,
  'packages/bwf/test/integration/cloudflare-durable-build.test.ts': 15_000,
  'packages/bwf/test/integration/cloudflare-deploy-build.test.ts': 6700,
  'packages/bwf/test/integration/durable-state-rpc.test.ts': 1160,
  'packages/bwf/test/integration/env-cli.test.ts': 2970,
  'packages/bwf/test/integration/env-server-build.test.ts': 873,
  'packages/bwf/test/integration/env-types-typecheck.test.ts': 1395,
  'packages/bwf/test/integration/full-deploy-manifest.test.ts': 6370,
  'packages/bwf/test/integration/kitchen-sink-build.test.ts': 7365,
  'packages/bwf/test/integration/kitchen-sink.test.ts': 20_887,
  'packages/bwf/test/integration/mysql-test.test.ts': 11_000,
  'packages/bwf/test/integration/operator-cli.test.ts': 4910,
  'packages/bwf/test/integration/pg-api-test.test.ts': 11_000,
  'packages/bwf/test/integration/pg-test.test.ts': 16_237,
  'packages/bwf/test/integration/plugin-env-schema.test.ts': 236,
  'packages/bwf/test/integration/prepare-cli.test.ts': 1957,
  'packages/bwf/test/integration/queue-dispatch.test.ts': 208,
  'packages/bwf/test/integration/sandbox-managed-rpc.test.ts': 722,
  'packages/bwf/test/integration/spa-middleware-auth.test.ts': 26_264,
  'packages/bwf/test/integration/trigger-auth.test.ts': 400,
  'packages/bwf/test/integration/websocket-middleware.test.ts': 11_188,
  'packages/bwf/test/integration/websockets-playground.test.ts': 16_783,
};
