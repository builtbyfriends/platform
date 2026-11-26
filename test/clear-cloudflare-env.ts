// Decision: A developer or a cloud session can hold real Cloudflare credentials in its environment. The deploy code reads
// them to skip its sign-in check and to pick an account, so a test then takes a different path than in CI. Each test file
// starts without them, and a test that needs one sets it with vi.stubEnv.
const CLOUDFLARE_ENV_VARS = [
  'CLOUDFLARE_API_TOKEN',
  'CF_API_TOKEN',
  'CLOUDFLARE_API_KEY',
  'CF_API_KEY',
  'CLOUDFLARE_EMAIL',
  'CF_EMAIL',
  'CLOUDFLARE_API_USER_SERVICE_KEY',
  'WRANGLER_CF_AUTHORIZATION_TOKEN',
  'WRANGLER_R2_SQL_AUTH_TOKEN',
  'CLOUDFLARE_ACCESS_CLIENT_ID',
  'CLOUDFLARE_ACCESS_CLIENT_SECRET',
  'CF_ACCESS_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'CF_ACCOUNT_ID',
  'CLOUDFLARE_ACCESS_KEY_ID',
  'CLOUDFLARE_SECRET_ACCESS_KEY',
  'CLOUDFLARE_S3_API_ENDPOINT',
];

for (const name of CLOUDFLARE_ENV_VARS) {
  delete process.env[name];
}
