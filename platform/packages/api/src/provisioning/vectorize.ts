import { isRecord } from '@builtbyfriends/deploy-core';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db.ts';
import { generateId } from '../id.ts';
import { projects, resources } from '../schema.ts';
import type { Resource } from '../types.ts';
import { cfFetch, CF_API_BASE, CloudflareApiError } from './cloudflare-api.ts';

export type VectorizeConfig = {
  dimensions: number;
  metric: 'cosine' | 'euclidean' | 'dot-product';
};
export function vectorizeConfig(value: unknown): VectorizeConfig | null {
  if (
    !isRecord(value) ||
    !Number.isInteger(value.dimensions) ||
    Number(value.dimensions) < 1 ||
    Number(value.dimensions) > 1536 ||
    (value.metric !== 'cosine' && value.metric !== 'euclidean' && value.metric !== 'dot-product')
  ) {
    return null;
  }
  return { dimensions: Number(value.dimensions), metric: value.metric };
}
export async function vectorizeIdentity(projectId: string, binding: string) {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([projectId, binding])),
  );
  const digest = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return { name: `bwf-v-${digest.slice(0, 56)}`, description: `bwf:vectorize:${digest}` };
}
export const vectorizeUrl = (account: string, name: string) =>
  `${CF_API_BASE}/${account}/vectorize/v2/indexes/${encodeURIComponent(name)}`;
export async function readOwnedVectorize(
  account: string,
  token: string,
  projectId: string,
  resource: Pick<Resource, 'cf_id' | 'binding_name' | 'metadata'>,
  signal?: AbortSignal,
) {
  const identity = await vectorizeIdentity(projectId, resource.binding_name);
  const expected = vectorizeConfig(resource.metadata);
  if (resource.cf_id !== identity.name || !expected) {
    throw Error('Invalid search index ownership.');
  }
  const value = await cfFetch<unknown>(vectorizeUrl(account, identity.name), token, { signal });
  const config = isRecord(value) ? vectorizeConfig(value.config) : null;
  if (
    !isRecord(value) ||
    value.name !== identity.name ||
    value.description !== identity.description ||
    !config ||
    config.dimensions !== expected.dimensions ||
    config.metric !== expected.metric
  ) {
    throw Error('Search index configuration or ownership changed.');
  }
  return config;
}
export async function ensureVectorize(
  db: Db,
  account: string,
  token: string,
  projectId: string,
  binding: string,
  requested: VectorizeConfig,
  ownerUserId?: string,
): Promise<Resource> {
  const config = vectorizeConfig(requested);
  if (!config || !/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(binding)) {
    throw Error('Invalid search index configuration.');
  }
  const identity = await vectorizeIdentity(projectId, binding);
  // Decision: Persist the owned creation intent before contacting the provider so an uncertain create remains discoverable by retries and project cleanup.
  const expectedOwner = await db.transaction(async (tx) => {
    const [project] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .for('update');
    if (
      !project ||
      project.status !== 'active' ||
      (ownerUserId !== undefined && project.user_id !== ownerUserId) ||
      project.preview_client_id ||
      project.suspended_reason
    ) {
      throw Error('This project cannot provision a search index.');
    }
    const [existing] = await tx
      .select()
      .from(resources)
      .where(
        and(
          eq(resources.project_id, projectId),
          eq(resources.type, 'vectorize'),
          eq(resources.binding_name, binding),
        ),
      );
    if (existing) {
      const saved = vectorizeConfig(existing.metadata);
      if (
        existing.cf_id !== identity.name ||
        !saved ||
        saved.dimensions !== config.dimensions ||
        saved.metric !== config.metric
      ) {
        throw Error(
          'Search index dimensions and distance metric cannot be changed. Use a new binding to create another index.',
        );
      }
      return project.user_id;
    }
    await tx.insert(resources).values({
      id: generateId('res'),
      project_id: projectId,
      type: 'vectorize',
      cf_id: identity.name,
      binding_name: binding,
      metadata: { ...config, provisioned: false },
    });
    return project.user_id;
  });
  // Decision: The project lock serializes index creation with project deletion and concurrent deploys; the durable intent survives a failed provider call.
  return db.transaction(async (tx) => {
    const [project] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .for('update');
    if (
      !project ||
      project.status !== 'active' ||
      project.user_id !== expectedOwner ||
      project.preview_client_id ||
      project.suspended_reason
    ) {
      throw Error('This project cannot provision a search index.');
    }
    const [resource] = await tx
      .select()
      .from(resources)
      .where(
        and(
          eq(resources.project_id, projectId),
          eq(resources.type, 'vectorize'),
          eq(resources.binding_name, binding),
        ),
      );
    const saved = resource ? vectorizeConfig(resource.metadata) : null;
    if (
      !resource ||
      resource.cf_id !== identity.name ||
      !saved ||
      saved.dimensions !== config.dimensions ||
      saved.metric !== config.metric
    ) {
      throw Error('Search index intent changed.');
    }
    const signal = AbortSignal.timeout(15_000);
    try {
      await readOwnedVectorize(account, token, projectId, resource, signal);
    } catch (error) {
      if (
        !(error instanceof CloudflareApiError) ||
        error.status !== 404 ||
        resource.metadata.provisioned !== false
      ) {
        throw error;
      }
      await cfFetch<unknown>(`${CF_API_BASE}/${account}/vectorize/v2/indexes`, token, {
        method: 'POST',
        signal,
        body: JSON.stringify({ ...identity, config }),
      });
      await readOwnedVectorize(account, token, projectId, resource, signal);
    }
    const [ready] = await tx
      .update(resources)
      .set({ metadata: { ...config, provisioned: true } })
      .where(eq(resources.id, resource.id))
      .returning();
    if (!ready) {
      throw Error('Search index ownership changed.');
    }
    return ready;
  });
}
export async function deleteOwnedVectorize(
  account: string,
  token: string,
  projectId: string,
  resource: Pick<Resource, 'cf_id' | 'binding_name' | 'metadata'>,
) {
  try {
    await readOwnedVectorize(account, token, projectId, resource, AbortSignal.timeout(10_000));
    await cfFetch<unknown>(vectorizeUrl(account, resource.cf_id), token, {
      method: 'DELETE',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (!(error instanceof CloudflareApiError) || error.status !== 404) {
      throw error;
    }
  }
}
