import { eq, or } from 'drizzle-orm';
import type { Context } from 'hono';
import { getProjectResources } from '../db/resources.ts';
import type { ApiEnv } from '../env.ts';
import { projectZeroTrust } from '../schema.ts';
import type { Resource } from '../types.ts';
import {
  readZeroTrustConfigurationStrict,
  ZeroTrustSavedConfigurationError,
  zeroTrustConfigurationStatus,
} from '../zero-trust/configuration.ts';
import { getProjectZeroTrustState, installationId } from '../zero-trust/state.ts';

export type RuntimeResourceReference =
  | { source: 'resources'; id: string; resource: Resource }
  | {
      source: 'project-access';
      id: string;
      projectId: string;
      name: string;
      kind: 'protected' | 'bypass';
      locator: { accountId: string; applicationId: string };
      proof: {
        installation: string;
        configurationRevision: number;
        operation: string;
        updatedAt: string;
        applicationName: string;
      };
    };

const products = {
  d1: 'd1',
  kv: 'kv',
  r2: 'r2',
  queue: 'queues',
  hyperdrive: 'hyperdrive',
  container: 'containers',
  'durable-object': 'durable-objects',
} satisfies { [Type in Resource['type']]: string };

export function sameResourceIdentity(current: Resource, previous: Resource): boolean {
  return (
    current.id === previous.id &&
    current.project_id === previous.project_id &&
    current.type === previous.type &&
    current.cf_id === previous.cf_id &&
    current.binding_name === previous.binding_name &&
    current.metadata.jurisdiction === previous.metadata.jurisdiction &&
    current.metadata.namespaceId === previous.metadata.namespaceId &&
    current.metadata.dispatchNamespace === previous.metadata.dispatchNamespace
  );
}

export function referenceProduct(reference: RuntimeResourceReference): string {
  return reference.source === 'resources' ? products[reference.resource.type] : 'access';
}

async function accessReferences(
  context: Context<ApiEnv>,
  projectId: string,
): Promise<Array<RuntimeResourceReference>> {
  const db = context.get('db');
  let configuration;
  try {
    configuration = await readZeroTrustConfigurationStrict(db);
  } catch (error) {
    if (error instanceof ZeroTrustSavedConfigurationError) {
      return [];
    }
    throw error;
  }
  if (
    !configuration?.enabled ||
    zeroTrustConfigurationStatus(configuration) !== 'ready' ||
    !configuration.wildcardApplication
  ) {
    return [];
  }
  const row = await getProjectZeroTrustState(db, projectId);
  if (
    !row ||
    row.status !== 'ready' ||
    row.desired_protected !== row.effective_protected ||
    !row.reconciled_operation ||
    row.last_error !== null
  ) {
    return [];
  }
  const references: Array<RuntimeResourceReference> = [];
  for (const kind of ['protected', 'bypass'] as const) {
    const applicationId = row[`${kind}_application_id`];
    const applicationName = row[`${kind}_application_name`];
    if (!applicationId || !applicationName) {
      continue;
    }
    if (
      row.protected_application_id === row.bypass_application_id ||
      applicationId === configuration.wildcardApplication.id ||
      applicationId === configuration.healthApplication?.id
    ) {
      continue;
    }
    const owners = await db
      .select({ projectId: projectZeroTrust.project_id })
      .from(projectZeroTrust)
      .where(
        or(
          eq(projectZeroTrust.protected_application_id, applicationId),
          eq(projectZeroTrust.bypass_application_id, applicationId),
        ),
      )
      .limit(2);
    if (owners.length !== 1 || owners[0].projectId !== projectId) {
      continue;
    }
    const installation = installationId(context.env);
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify([installation, projectId, 'project-access', kind])),
    );
    const opaque = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    references.push({
      source: 'project-access',
      id: `ref_${opaque}`,
      projectId,
      name: kind === 'protected' ? 'Project access' : 'Public access',
      kind,
      locator: { accountId: configuration.accountId, applicationId },
      proof: {
        installation,
        configurationRevision: configuration.revision,
        operation: row.reconciled_operation,
        updatedAt: row.updated_at,
        applicationName,
      },
    });
  }
  return references;
}

export async function runtimeResourceReferences(
  context: Context<ApiEnv>,
  projectId: string,
  resources?: ReadonlyArray<Resource>,
): Promise<ReadonlyArray<RuntimeResourceReference>> {
  const provisioned = resources ?? (await getProjectResources(context.get('db'), projectId));
  return [
    ...provisioned.map((resource) => ({ source: 'resources' as const, id: resource.id, resource })),
    ...(await accessReferences(context, projectId)),
  ];
}

export function sameResourceReference(
  current: RuntimeResourceReference,
  previous: RuntimeResourceReference,
): boolean {
  if (current.id !== previous.id || current.source !== previous.source) {
    return false;
  }
  if (current.source === 'resources' && previous.source === 'resources') {
    return sameResourceIdentity(current.resource, previous.resource);
  }
  return (
    current.source === 'project-access' &&
    previous.source === 'project-access' &&
    current.projectId === previous.projectId &&
    current.kind === previous.kind &&
    current.locator.accountId === previous.locator.accountId &&
    current.locator.applicationId === previous.locator.applicationId &&
    current.proof.installation === previous.proof.installation &&
    current.proof.configurationRevision === previous.proof.configurationRevision &&
    current.proof.operation === previous.proof.operation &&
    current.proof.updatedAt === previous.proof.updatedAt &&
    current.proof.applicationName === previous.proof.applicationName
  );
}
