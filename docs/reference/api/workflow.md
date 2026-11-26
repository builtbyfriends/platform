---
description: 'Declare a Cloudflare Workflow from bwf/workflow.'
outline: deep
---

# Workflows {#workflows}

Imported from `"@builtbyfriends/bwf/workflow"`. See [Workflows](../../guide/workflows.md) for the file convention and deployment support.

## `defineWorkflow(definition)` {#defineworkflow-definition}

Registers a class that extends `WorkflowEntrypoint`. The returned object must be the default export of a module under `workflows/`.

```ts
function defineWorkflow<TClass>(definition: { name?: string; class: TClass }): WorkflowApi<TClass>;
```

`WorkflowApi` exposes `class`, `create({ id?, params? })`, `createBatch(batch)` and `get(id)`. They call the Workflow binding that bwf adds for the file, and return Cloudflare's `WorkflowInstance`.
