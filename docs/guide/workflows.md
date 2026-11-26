---
description: 'Run a durable, multi-step job with a Cloudflare Workflow, declared from a folder.'
outline: deep
---

# Workflows

Use a [Cloudflare Workflow](https://developers.cloudflare.com/workflows/) for a job that has several steps and needs to survive failures, such as sending a welcome series or waiting for an approval. Each step keeps its result. If the job stops, it picks up from the last finished step.

Put one Workflow in each file in `workflows/`. bwf adds the binding, exports the class from the Worker, and writes the `workflows` entry in the Worker config. You don't edit `wrangler.jsonc`. This feature supports direct Cloudflare deployments (`bwf deploy --platform cloudflare`). A deploy to a bwf platform stops with an error if the app has a `workflows/` folder.

## Write a Workflow

Extend `WorkflowEntrypoint` and default-export the class through `defineWorkflow()`:

```ts
import { defineWorkflow } from '@builtbyfriends/bwf/workflow';
// workflows/welcome.ts
import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

class Welcome extends WorkflowEntrypoint<Env, { name: string }> {
  async run(event: WorkflowEvent<{ name: string }>, step: WorkflowStep) {
    const greeting = await step.do('greet', async () => `Hello ${event.payload.name}`);
    await step.sleep('wait a day', '1 day');
    return greeting;
  }
}

export default defineWorkflow({ class: Welcome });
```

The file name sets the names. `workflows/welcome.ts` gives the binding `WELCOME`, the class `WelcomeWorkflow`, and the Workflow name `welcome`. `workflows/send-welcome.ts` gives `SEND_WELCOME`, `SendWelcomeWorkflow` and `send-welcome`.

Cloudflare keeps the Workflow name for your account. To keep a Workflow when you move its code, set `name` in `defineWorkflow()` and run `bwf info` to see the names bwf chose.

## Start and check an instance

Import the definition in a route. `create()` starts an instance, and `get()` finds one by its id:

```ts
// routes/api/welcome.ts
import { defineHandler } from '@builtbyfriends/bwf';
import welcome from '../../workflows/welcome';

export const POST = defineHandler(async () => {
  const instance = await welcome.create({ params: { name: 'Ada' } });
  return { id: instance.id };
});

export const GET = defineHandler(async (c) => {
  const instance = await welcome.get(c.req.query('id')!);
  return await instance.status();
});
```

`createBatch()` starts several instances in one call. Other Workflow settings, such as retries and schedules, follow Cloudflare's own Workflows documentation.

## Deploying

A deploy that adds a Workflow class changes the exports of the Worker. Cloudflare can't split traffic between two versions with different exports. If the deploy stops with that message, run it once with `--atomic`.

Workflows work on the Workers Free plan.
