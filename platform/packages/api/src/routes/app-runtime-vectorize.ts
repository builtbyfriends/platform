import { isRecord } from '@builtbyfriends/deploy-core';
import { getPlatformCapabilities } from '../capabilities.ts';
import type { ApiEnv } from '../env.ts';
import { cfFetch } from '../provisioning/cloudflare-api.ts';
import { readOwnedVectorize, vectorizeConfig, vectorizeUrl } from '../provisioning/vectorize.ts';
import type { Project, Resource } from '../types.ts';

export function vectorQuery(vector: unknown, topK: unknown) {
  if (
    typeof vector !== 'string' ||
    vector.length > 32_768 ||
    (topK !== undefined && (typeof topK !== 'string' || !/^(?:[1-9]|1[0-9]|20)$/.test(topK)))
  ) {
    return null;
  }
  try {
    const values: unknown = JSON.parse(vector);
    if (
      !Array.isArray(values) ||
      values.length < 1 ||
      values.length > 1536 ||
      !values.every(
        (value: unknown) =>
          typeof value === 'number' &&
          Number.isFinite(value) &&
          Number.isFinite(Math.fround(value)),
      )
    ) {
      return null;
    }
    return { vector: values.map(Number), topK: topK === undefined ? 5 : Number(topK) };
  } catch {
    return null;
  }
}
export function vectorizeRuntimeAvailable(env: ApiEnv['Bindings'], project: Project) {
  return Boolean(
    getPlatformCapabilities(env).vectorize &&
    env.CF_ACCOUNT_ID &&
    env.CF_API_TOKEN &&
    project.active_deployment_id &&
    project.status === 'active' &&
    !project.preview_client_id &&
    !project.suspended_reason,
  );
}
export async function vectorizeRecords(
  env: ApiEnv['Bindings'],
  project: Project,
  resource: Resource,
  action: 'index.info' | 'index.query',
  input: { vector?: string; topK?: string },
) {
  if (
    !vectorizeRuntimeAvailable(env, project) ||
    resource.type !== 'vectorize' ||
    resource.project_id !== project.id ||
    resource.metadata.provisioned !== true
  ) {
    throw Error('Search index is unavailable.');
  }
  const signal = AbortSignal.timeout(7500);
  const config = await readOwnedVectorize(
    env.CF_ACCOUNT_ID,
    env.CF_API_TOKEN,
    project.id,
    resource,
    signal,
  );
  const base = { kind: 'records' as const, checkedAt: Date.now(), truncated: false };
  const url = vectorizeUrl(env.CF_ACCOUNT_ID, resource.cf_id);
  if (action === 'index.info') {
    const info = await cfFetch<unknown>(`${url}/info`, env.CF_API_TOKEN, { signal });
    if (
      !isRecord(info) ||
      (info.dimensions !== undefined && info.dimensions !== config.dimensions) ||
      (info.vectorCount !== undefined &&
        (!Number.isSafeInteger(info.vectorCount) || Number(info.vectorCount) < 0)) ||
      (info.processedUpToDatetime !== undefined &&
        (typeof info.processedUpToDatetime !== 'string' ||
          info.processedUpToDatetime.length > 100 ||
          !Number.isFinite(Date.parse(info.processedUpToDatetime))))
    ) {
      throw Error('Invalid search index status.');
    }
    return {
      ...base,
      checkedAt: Date.now(),
      columns: [
        { id: 'property', label: 'Property' },
        { id: 'value', label: 'Value' },
      ],
      rows: [
        { id: 'dimensions', cells: ['Dimensions', config.dimensions] },
        { id: 'metric', cells: ['Distance metric', config.metric] },
        {
          id: 'vectors',
          cells: [
            'Indexed vectors',
            typeof info.vectorCount === 'number' ? info.vectorCount : null,
          ],
        },
        {
          id: 'processed',
          cells: [
            'Changes processed through',
            typeof info.processedUpToDatetime === 'string' ? info.processedUpToDatetime : null,
          ],
        },
      ],
    };
  }
  const query = vectorQuery(input.vector, input.topK);
  if (!query) {
    throw Error('Invalid search vector.');
  }
  if (query.vector.length !== config.dimensions) {
    return {
      kind: 'unavailable' as const,
      reason: `Enter exactly ${config.dimensions} numbers for this index. The query must use the same embedding model as the stored vectors.`,
    };
  }
  const result = await cfFetch<unknown>(`${url}/query`, env.CF_API_TOKEN, {
    method: 'POST',
    signal,
    body: JSON.stringify({ ...query, returnValues: false, returnMetadata: 'none' }),
  });
  if (!isRecord(result) || !Array.isArray(result.matches) || result.matches.length > query.topK) {
    throw Error('Invalid search results.');
  }
  const rows = result.matches.map((match: unknown) => {
    if (
      !isRecord(match) ||
      typeof match.id !== 'string' ||
      !match.id ||
      new TextEncoder().encode(match.id).length > 64 ||
      Array.from(match.id).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      typeof match.score !== 'number' ||
      !Number.isFinite(match.score)
    ) {
      throw Error('Invalid search match.');
    }
    return { id: match.id, cells: [match.id, match.score] };
  });
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw Error('Duplicate search matches.');
  }
  return {
    ...base,
    checkedAt: Date.now(),
    columns: [
      { id: 'id', label: 'Record' },
      { id: 'score', label: 'Score' },
    ],
    rows,
  };
}
export function vectorizeManifestOwns(serialized: string | null, resource: Resource) {
  let manifest: unknown;
  try {
    manifest = JSON.parse(serialized ?? 'null');
  } catch {
    return false;
  }
  if (!isRecord(manifest) || !Array.isArray(manifest.vectorize)) {
    return false;
  }
  const config = vectorizeConfig(resource.metadata);
  return Boolean(
    config &&
    manifest.vectorize.some(
      (value: unknown) =>
        isRecord(value) &&
        value.bindingName === resource.binding_name &&
        value.dimensions === config.dimensions &&
        value.metric === config.metric,
    ),
  );
}
