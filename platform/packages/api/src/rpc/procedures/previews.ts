import { type } from 'arktype';
import { OAuthError } from '../../auth/oauth.ts';
import { activeOAuthClient } from '../../auth/oauth.ts';
import {
  createPreview,
  launchPreview,
  requestPreviewDeployment,
  requirePreviewPermission,
} from '../../routes/previews.ts';
import { appProcedure, connectedApp } from '../app-procedure.ts';
import type { AppCaller } from '../app-procedure.ts';

const PREVIEW_ERRORS = {
  ACCESS_DENIED: { status: 403, message: 'preview access denied' },
  NOT_FOUND: { status: 404, message: 'preview unavailable' },
  INVALID_REQUEST: { status: 400, message: 'invalid preview request' },
  NOT_READY: { status: 409, message: 'the first preview build is not ready' },
  UNAVAILABLE: { status: 503, message: 'preview temporarily unavailable' },
} as const;

type Code = keyof typeof PREVIEW_ERRORS;

/** Maps the OAuth layer's errors onto the procedure's declared refusals. */
export function previewRefusal(error: unknown): { code: Code; message: string } | null {
  if (!(error instanceof OAuthError)) {
    return null;
  }
  const code: Code =
    error.status === 404
      ? 'NOT_FOUND'
      : error.status === 409
        ? 'NOT_READY'
        : error.status === 503
          ? 'UNAVAILABLE'
          : error.status === 400
            ? 'INVALID_REQUEST'
            : 'ACCESS_DENIED';
  return { code, message: error.message };
}

/** The grant and its client must both hold `preview:deploy`. */
async function permitted(caller: AppCaller): Promise<AppCaller> {
  requirePreviewPermission(
    caller.grant,
    await activeOAuthClient(caller.db, caller.grant.client_id),
  );
  return caller;
}

export const create = appProcedure('previews.create')
  .use(connectedApp)
  .noAuthz({ reason: 'The grant must hold preview:deploy, checked in the handler' })
  .input(type({ workspace: 'string' }))
  .output(type({ project_id: 'string', url: 'string', deployment_id: 'string | null' }))
  .errors(PREVIEW_ERRORS)
  .noMcp({ reason: 'Connected applications call this over /app-rpc with their grant' })
  .noCli({ reason: 'There is no CLI for connected applications' })
  .handler(async ({ ctx, input, fail }) => {
    try {
      return await createPreview(await permitted(ctx), input);
    } catch (error) {
      const refusal = previewRefusal(error);
      if (refusal) {
        return fail(refusal.code, refusal.message);
      }
      throw error;
    }
  });

export const deploy = appProcedure('previews.deploy')
  .use(connectedApp)
  .noAuthz({
    reason: 'The grant must hold preview:deploy and own the preview, checked in the handler',
  })
  .input(type({ project_id: 'string', checkpoint: 'string', artifact: 'object' }))
  .output(type({ access_token: 'string', project_id: 'string', approval_id: 'string' }))
  .errors(PREVIEW_ERRORS)
  .noMcp({ reason: 'Connected applications call this over /app-rpc with their grant' })
  .noCli({ reason: 'There is no CLI for connected applications' })
  .handler(async ({ ctx, input, fail }) => {
    try {
      return await requestPreviewDeployment(
        await permitted(ctx),
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the callee validates the artifact at runtime
        input as Parameters<typeof requestPreviewDeployment>[1],
      );
    } catch (error) {
      const refusal = previewRefusal(error);
      if (refusal) {
        return fail(refusal.code, refusal.message);
      }
      throw error;
    }
  });

export const launch = appProcedure('previews.launch')
  .use(connectedApp)
  .noAuthz({
    reason: 'The grant must hold preview:deploy and own the preview, checked in the handler',
  })
  .input(type({ project_id: 'string' }))
  .output(type({ url: 'string' }))
  .errors(PREVIEW_ERRORS)
  .noMcp({ reason: 'Connected applications call this over /app-rpc with their grant' })
  .noCli({ reason: 'There is no CLI for connected applications' })
  .handler(async ({ ctx, input, fail }) => {
    try {
      return await launchPreview(await permitted(ctx), input.project_id);
    } catch (error) {
      const refusal = previewRefusal(error);
      if (refusal) {
        return fail(refusal.code, refusal.message);
      }
      throw error;
    }
  });
