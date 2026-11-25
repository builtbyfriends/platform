/** Stub interface augmented by generated .bwf/queues.d.ts */
export interface QueueMap {}

import { requireRuntimeBinding } from './env.ts';

/** Typed queue producers — resolves `QUEUE_*` bindings from the active runtime environment. */
export const queues: QueueMap = new Proxy(
  {},
  {
    get(_, name: string) {
      const bindingName = `QUEUE_${name.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_')}`;
      return requireRuntimeBinding(bindingName);
    },
  },
);
