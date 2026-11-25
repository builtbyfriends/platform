import { type } from 'arktype';

const identifier = type('string > 0')
  .atMostLength(200)
  .narrow((value) => !/\p{Cc}/u.test(value));

const field = type({
  name: identifier,
  type: "'string' | 'number' | 'boolean' | 'array' | 'object' | 'unknown'",
  required: 'boolean',
  'description?': type('string').atMostLength(16_000),
  'flag?': identifier,
  'positional?': 'boolean',
});

const operation = type({
  operationId: identifier,
  httpMethod: "'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'",
  path: type('string > 0')
    .atMostLength(2000)
    .narrow(
      (value) => value.startsWith('/') && !value.startsWith('//') && !/[\p{Cc}?#]/u.test(value),
    ),
  pathParams: field.array().atMostLength(100),
  queryParams: field.array().atMostLength(100),
  hasRequestBody: 'boolean',
  requestBodyFields: field.array().atMostLength(200),
});

const snapshot = type({
  version: "'1.0'",
  generatedAt: 'string',
  schemas: { '[string]': operation },
});

export type CloudflareDiscoveryField = Pick<typeof field.infer, 'name' | 'type' | 'required'> & {
  description?: string;
  flag?: string;
  positional?: boolean;
};

export type CloudflareDiscoveryOperation = {
  id: string;
  command: string;
  httpMethod: typeof operation.infer.httpMethod;
  path: string;
  pathParams: Array<CloudflareDiscoveryField>;
  queryParams: Array<CloudflareDiscoveryField>;
  requestBodyFields: Array<CloudflareDiscoveryField>;
  hasRequestBody: boolean;
  inputCompleteness: 'summary';
  execution: 'discovery-only';
};

export type CloudflareDiscoveryCatalog = {
  source: {
    kind: 'cloudflare-cli';
    cliVersion: string;
    schemaVersion: '1.0';
    generatedAt: string;
    sha256: string;
  };
  operations: Array<CloudflareDiscoveryOperation>;
};

function fields(values: Array<typeof field.infer>): Array<CloudflareDiscoveryField> {
  return values.map(({ name, type, required, description, flag, positional }) => {
    const result: CloudflareDiscoveryField = { name, type, required };

    if (description !== undefined) {
      result.description = description;
    }

    if (flag !== undefined) {
      result.flag = flag;
    }

    if (positional !== undefined) {
      result.positional = positional;
    }

    return result;
  });
}

// Decision: CLI field summaries cannot validate inputs or authorize tenant operations.
export async function loadCloudflareDiscoveryCatalog(
  schemaJson: string,
  cliVersion: string,
): Promise<CloudflareDiscoveryCatalog> {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(cliVersion) || cliVersion.length > 100) {
    throw Error('Pin an exact Cloudflare CLI version.');
  }

  if (schemaJson.length > 8 * 1024 * 1024) {
    throw Error('Cloudflare discovery metadata exceeds the size limit.');
  }

  const bytes = new TextEncoder().encode(schemaJson);

  if (bytes.byteLength > 8 * 1024 * 1024) {
    throw Error('Cloudflare discovery metadata exceeds the size limit.');
  }

  const data = snapshot(JSON.parse(schemaJson));

  if (
    data instanceof type.errors ||
    (data.generatedAt !== 'build-time' && !Number.isFinite(Date.parse(data.generatedAt)))
  ) {
    throw Error('Invalid Cloudflare discovery metadata.');
  }

  const entries = Object.entries(data.schemas);

  if (entries.length === 0 || entries.length > 5000) {
    throw Error('Cloudflare discovery metadata exceeds the operation limit.');
  }

  const ids = new Set<string>();

  const operations = entries
    .map(([command, value]): CloudflareDiscoveryOperation => {
      if (!/^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*$/.test(command) || command.length > 300) {
        throw Error('Invalid Cloudflare discovery command.');
      }

      if (ids.has(value.operationId)) {
        throw Error('Duplicate Cloudflare discovery operation.');
      }

      ids.add(value.operationId);

      return {
        id: value.operationId,
        command: `cf ${command}`,
        httpMethod: value.httpMethod,
        path: value.path,
        pathParams: fields(value.pathParams),
        queryParams: fields(value.queryParams),
        requestBodyFields: fields(value.requestBodyFields),
        hasRequestBody: value.hasRequestBody,
        inputCompleteness: 'summary',
        execution: 'discovery-only',
      };
    })
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const digest = await crypto.subtle.digest('SHA-256', bytes);

  return {
    source: {
      kind: 'cloudflare-cli',
      cliVersion,
      schemaVersion: data.version,
      generatedAt: data.generatedAt,
      sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
        '',
      ),
    },
    operations,
  };
}
