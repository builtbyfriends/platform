import type { WorkflowEntrypoint } from 'cloudflare:workers';
import { isResourceName } from '../shared/resource-name.ts';
import { requireRuntimeBinding } from './env.ts';

type NativeWorkflowClass = new (...args: Array<never>) => WorkflowEntrypoint<unknown, unknown>;

type WorkflowPayload<TClass extends NativeWorkflowClass> =
  InstanceType<TClass> extends WorkflowEntrypoint<infer _TEnv, infer TParams> ? TParams : unknown;

export type WorkflowApi<TClass extends NativeWorkflowClass> = {
  class: TClass;
  /** @internal Called by the generated Worker entry. */
  __bind(bindingName: string, resourceName?: string): void;
  create(options?: { id?: string; params?: WorkflowPayload<TClass> }): Promise<WorkflowInstance>;
  createBatch(
    batch: ReadonlyArray<{ id?: string; params?: WorkflowPayload<TClass> }>,
  ): Promise<Array<WorkflowInstance>>;
  get(id: string): Promise<WorkflowInstance>;
};

/** Register a native Workflow class. Default-export it from a file in `workflows/`. */
export function defineWorkflow<TClass extends NativeWorkflowClass>(definition: {
  name?: string;
  class: TClass;
}): WorkflowApi<TClass> {
  if (definition.name !== undefined && !isResourceName(definition.name)) {
    throw new Error('workflow: name must contain a word starting with a letter.');
  }
  let bindingName: string | undefined;
  function boundWorkflow(): Workflow<WorkflowPayload<TClass>> {
    if (!bindingName) {
      throw new Error(
        'workflow: this definition is not bound. Default-export it from a file in workflows/.',
      );
    }
    return requireRuntimeBinding<Workflow<WorkflowPayload<TClass>>>(bindingName);
  }
  return {
    class: definition.class,
    __bind(name, resourceName) {
      if (definition.name !== resourceName) {
        throw new Error(
          'workflow: name must be statically discoverable in defineWorkflow(). Run bwf info to inspect this definition.',
        );
      }
      if (bindingName && bindingName !== name) {
        throw new Error(
          `workflow: definition is already bound to '${bindingName}' and cannot also bind to '${name}'.`,
        );
      }
      bindingName = name;
    },
    create(options) {
      return boundWorkflow().create(options);
    },
    createBatch(batch) {
      return boundWorkflow().createBatch([...batch]);
    },
    get(id) {
      return boundWorkflow().get(id);
    },
  };
}
