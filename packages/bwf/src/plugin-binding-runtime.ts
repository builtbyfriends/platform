import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

type BindingNames = { kv?: string; r2?: string };

const envModuleResolved = fileURLToPath(import.meta.resolve('#self/_env'));
const kvModuleResolved = fileURLToPath(import.meta.resolve('@builtbyfriends/bwf/kv'));
const storageModuleResolved = fileURLToPath(import.meta.resolve('@builtbyfriends/bwf/storage'));
const VIRTUAL_KV_ID = '\0virtual:platform-kv';
const VIRTUAL_STORAGE_ID = '\0virtual:platform-storage';

export function bindingRuntimePlugin(bindingNames: BindingNames | undefined): Plugin {
  return {
    name: 'platform:binding-runtime',
    enforce: 'pre',
    resolveId: {
      filter: { id: /^(@builtbyfriends\/bwf\/kv|@builtbyfriends\/bwf\/storage)$/ },
      handler(id) {
        if (this.environment?.name === 'client') {
          return;
        }
        if (id === '@builtbyfriends/bwf/kv' && bindingNames?.kv) {
          return VIRTUAL_KV_ID;
        }
        if (id === '@builtbyfriends/bwf/storage' && bindingNames?.r2) {
          return VIRTUAL_STORAGE_ID;
        }
      },
    },
    load: {
      filter: { id: /^\0virtual:platform-(?:kv|storage)$/ },
      handler(id) {
        if (id === VIRTUAL_KV_ID) {
          return `
import { requireRuntimeBinding } from ${JSON.stringify(envModuleResolved)};
import { createKV } from ${JSON.stringify(kvModuleResolved)};

const namespace = new Proxy({}, {
  get(_, prop) {
    const ns = requireRuntimeBinding(${JSON.stringify(bindingNames?.kv)});
    const value = Reflect.get(ns, prop, ns);
    return typeof value === 'function' ? value.bind(ns) : value;
  },
});

export { createKV };
export const kv = createKV(namespace);
`;
        }

        if (id === VIRTUAL_STORAGE_ID) {
          return `
import { requireRuntimeBinding } from ${JSON.stringify(envModuleResolved)};
export { createStorage } from ${JSON.stringify(storageModuleResolved)};

export const storage = new Proxy({}, {
  get(_, prop) {
    const bucket = requireRuntimeBinding(${JSON.stringify(bindingNames?.r2)});
    const value = Reflect.get(bucket, prop, bucket);
    return typeof value === 'function' ? value.bind(bucket) : value;
  },
});
`;
        }
      },
    },
  };
}
