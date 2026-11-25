import { describe, expect, it } from 'vite-plus/test';
import {
  createDeployResourcePlan,
  validateManifestShape,
  validateVectorize,
  SUPPORTED_MANIFEST_VERSIONS,
} from '../../src/index.ts';
import type { VectorizeConfig } from '../../src/index.ts';
const index: VectorizeConfig = { bindingName: 'SEARCH', dimensions: 384, metric: 'cosine' };

describe('managed Vectorize contract', () => {
  it('retains the typed resource and requires explicit protocol support', () => {
    expect(SUPPORTED_MANIFEST_VERSIONS).toContain(6);
    expect(validateManifestShape({ version: 6, bindings: {}, vectorize: [index] })).toBeNull();
    expect(
      createDeployResourcePlan({ version: 6, bindings: {}, vectorize: [index] }).resources,
    ).toEqual([{ type: 'vectorize', ...index }]);
    expect(validateManifestShape({ version: 5, bindings: {}, vectorize: [index] })).toContain(
      'version 6',
    );
    expect(
      validateManifestShape({ version: 6, type: 'static', bindings: {}, vectorize: [index] }),
    ).toContain('Worker');
    expect(
      validateManifestShape({
        version: 6,
        bindings: {},
        vectorize: [index],
        storage: { locationHint: 'apac' },
        durableObjects: {
          bindings: [{ bindingName: 'ROOM', className: 'Room', storage: 'sqlite' }],
        },
      }),
    ).toBeNull();
  });
  it.each([0, -1, 1537, 1.5, NaN, Infinity, '384', null])(
    'rejects invalid dimensions %s',
    (dimensions) => {
      expect(validateVectorize([{ ...index, dimensions }])).toContain('dimensions');
    },
  );
  it.each(['', 'bad-name', '__PRIVATE', 'DB', 'ASSETS', 'a'.repeat(65)])(
    'rejects invalid name %s',
    (bindingName) => {
      expect(validateVectorize([{ ...index, bindingName }])).toContain('bindingName');
    },
  );
  it('rejects excess indexes, unknown fields, bad metrics and duplicate names', () => {
    expect(
      validateVectorize(
        Array.from({ length: 33 }, (_, n) => ({ ...index, bindingName: `INDEX_${n}` })),
      ),
    ).toContain('32');
    expect(validateVectorize([{ ...index, remoteId: 'untrusted' }])).toContain('only');
    expect(validateVectorize([{ ...index, metric: 'wrong' }])).toContain('metric');
    expect(validateVectorize([index, index])).toContain('unique');
  });
  it.each([
    { bindings: { kv: ['SEARCH'] } },
    { vars: { SEARCH: 'value' } },
    { queues: [{ name: 'search', bindingName: 'SEARCH' }] },
    {
      durableObjects: {
        bindings: [{ bindingName: 'SEARCH', className: 'Search', storage: 'sqlite' }],
      },
    },
  ])('rejects binding collisions %j', (extra) => {
    expect(
      validateManifestShape({ version: 6, bindings: {}, vectorize: [index], ...extra }),
    ).toContain('collide');
  });
});
