import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { expect, it } from 'vite-plus/test';
import { decodeCloudflareOperationResult } from '../../src/cli/cloudflare-process.ts';
import { Buffer } from '../../src/cli/node-buffer.ts';
import {
  listen,
  runOperation,
  temporaryDirectory,
  tokenEnv,
} from '../helpers/cloudflare-operation-process.ts';

it('uses the typed authenticated Vectorize API and preserves immutable creation config', async () => {
  const directory = temporaryDirectory('vectorize-operation-');
  const configPath = join(directory, 'wrangler.json');
  writeFileSync(configPath, JSON.stringify({ account_id: 'test-account' }));
  const requests: Array<{
    method: string;
    path: string;
    body: string;
    authorization: string | undefined;
  }> = [];
  const remote = {
    name: 'app-vectors',
    config: { dimensions: 384, metric: 'cosine' },
    description: 'bwf:app:SEARCH',
  };
  const api = await listen(
    createServer((request, response) => {
      const chunks: Array<Buffer> = [];
      request.on('data', (chunk: Buffer) => {
        chunks.push(Buffer.from(chunk));
      });
      request.on('end', () => {
        requests.push({
          method: request.method ?? '',
          path: request.url ?? '',
          body: Buffer.concat(chunks).toString(),
          authorization: request.headers.authorization,
        });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ success: true, result: remote }));
      });
    }),
  );
  const created = await runOperation(
    directory,
    {
      type: 'vectorize.create',
      name: remote.name,
      dimensions: 384,
      metric: 'cosine',
      description: remote.description,
      configPath,
    },
    tokenEnv(api),
  );
  expect(created.status, created.stderr).toBe(0);
  expect(decodeCloudflareOperationResult(created).data).toEqual(remote);
  const read = await runOperation(
    directory,
    { type: 'vectorize.info', name: remote.name, configPath },
    tokenEnv(api),
  );
  expect(read.status, read.stderr).toBe(0);
  expect(
    requests.map(({ method, path, authorization }) => ({ method, path, authorization })),
  ).toEqual([
    {
      method: 'POST',
      path: '/client/v4/accounts/test-account/vectorize/v2/indexes',
      authorization: 'Bearer synthetic-token',
    },
    {
      method: 'GET',
      path: '/client/v4/accounts/test-account/vectorize/v2/indexes/app-vectors',
      authorization: 'Bearer synthetic-token',
    },
  ]);
  expect(JSON.parse(requests[0].body)).toEqual(remote);
});

it.each([403, 404, 500])(
  'classifies Vectorize HTTP %s without assuming permission errors mean missing',
  async (status) => {
    const directory = temporaryDirectory('vectorize-error-');
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(configPath, '{}');
    const api = await listen(
      createServer((_request, response) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            success: false,
            errors: [{ code: 1000, message: 'No index available' }],
          }),
        );
      }),
    );
    const read = decodeCloudflareOperationResult(
      await runOperation(
        directory,
        { type: 'vectorize.info', name: 'missing', configPath },
        tokenEnv(api),
      ),
    );
    expect(read.status).not.toBe(0);
    expect(read.failure).toBe(status === 404 ? 'not-found' : undefined);
  },
);
