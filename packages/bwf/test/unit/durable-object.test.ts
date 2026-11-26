import { DurableObject } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vite-plus/test';
import { defineDurableObject } from '../../src/runtime/durable.ts';
import { withRuntimeEnv } from '../../src/runtime/env.ts';

const workerExports = vi.hoisted((): Record<string, unknown> => ({}));

vi.mock('cloudflare:workers', () => ({ DurableObject: class {}, exports: workerExports }));

describe('defineDurableObject', () => {
  it('retains the native class and resolves a named namespace without wrapping its lifecycle', () => {
    class Native extends DurableObject {
      async ask() {
        return 'answer';
      }
      async alarm() {
        return;
      }
    }
    const Agent = defineDurableObject({ name: 'workspace', class: Native });
    const id = {} as DurableObjectId;
    const stub = { ask: vi.fn(async () => 'answer') };
    const namespace = {
      idFromName: vi.fn(() => id),
      get: vi.fn(() => stub),
    } as unknown as DurableObjectNamespace<Native>;
    expect(Agent.class).toBe(Native);
    expect(() => Agent.get('room')).toThrow('not bound');
    Agent.__bind('WORKSPACE', 'workspace');
    expect(withRuntimeEnv({ WORKSPACE: namespace }, () => Agent.get('room'))).toBe(stub);
    expect(namespace.idFromName).toHaveBeenCalledWith('room');
    expect(Agent.getById(namespace, id)).toBe(stub);
    expect(() => Agent.__bind('OTHER', 'workspace')).toThrow('already bound');
  });

  it('rejects a runtime resource identity that differs from static analysis', () => {
    class Native extends DurableObject {}
    const Agent = defineDurableObject({ name: 'workspace', class: Native });
    expect(() => Agent.__bind('WORKSPACE', 'other')).toThrow('statically discoverable');
    expect(() => defineDurableObject({ name: '123', class: Native })).toThrow('name must contain');
  });

  describe('reaching its owners from a Worker Preview', () => {
    function namespaceOf(label: string) {
      const stub = { label };

      return {
        stub,
        namespace: {
          idFromName: vi.fn(() => ({})),
          get: vi.fn(() => stub),
        } as unknown as DurableObjectNamespace,
      };
    }

    it("takes the Worker's own export, since only that namespace is separate in a preview", () => {
      class Native extends DurableObject {}
      const Agent = defineDurableObject({ name: 'workspace', class: Native });
      const exported = namespaceOf('export');
      const bound = namespaceOf('env');
      workerExports.WorkspaceDurableObject = exported.namespace;
      Agent.__bind('WORKSPACE', 'workspace', 'WorkspaceDurableObject');

      try {
        expect(withRuntimeEnv({ WORKSPACE: bound.namespace }, () => Agent.get('room'))).toBe(
          exported.stub,
        );
        expect(bound.namespace.get).not.toHaveBeenCalled();
      } finally {
        delete workerExports.WorkspaceDurableObject;
      }
    });

    it('keeps the env binding when the export is missing, or when the entry names no class', () => {
      class Native extends DurableObject {}
      const named = defineDurableObject({ name: 'workspace', class: Native });
      const unnamed = defineDurableObject({ name: 'workspace', class: Native });
      const bound = namespaceOf('env');
      named.__bind('WORKSPACE', 'workspace', 'WorkspaceDurableObject');
      unnamed.__bind('WORKSPACE', 'workspace');

      expect(withRuntimeEnv({ WORKSPACE: bound.namespace }, () => named.get('room'))).toBe(
        bound.stub,
      );
      expect(withRuntimeEnv({ WORKSPACE: bound.namespace }, () => unnamed.get('room'))).toBe(
        bound.stub,
      );
    });
  });
});
