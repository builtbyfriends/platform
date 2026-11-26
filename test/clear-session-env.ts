// Decision: A developer or a cloud session can hold real Cloudflare credentials and HTTP proxy settings in its
// environment. The deploy code reads the credentials to skip its sign-in check and to pick an account, and Node reads the
// lowercase proxy names before the uppercase ones a test sets, so a test then takes a different path than in CI. Each test
// file starts without them, and a test that needs one sets it with vi.stubEnv or in the environment it passes to a child.
const SESSION_ENV_VARS = [
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
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

for (const name of SESSION_ENV_VARS) {
  delete process.env[name];
}
