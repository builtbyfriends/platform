import { type } from 'arktype';
import { requestPublishApproval } from '../../routes/oauth.ts';
import type { PublishRequestBody } from '../../routes/oauth.ts';
import { appProcedure, connectedApp } from '../app-procedure.ts';
import { previewRefusal } from './previews.ts';

/**
 * Starts a publish. Nothing is deployed until the signed-in user opens `authorization_url` and
 * approves it: the approval itself is a browser consent, never an API call.
 */
export const request = appProcedure('publish.request')
  .use(connectedApp)
  .noAuthz({ reason: 'The client must hold deploy:approve, checked in the handler' })
  .input(
    type({
      redirect_uri: 'string',
      state: 'string',
      code_challenge: 'string',
      code_challenge_method: 'string',
      slug: 'string',
      checkpoint: 'string',
      artifact: 'object',
      'payer?': 'string',
    }),
  )
  .output(type({ authorization_url: 'string', request_id: 'string', expires_in: 'number' }))
  .errors({
    ACCESS_DENIED: { status: 403, message: 'publishing is not enabled for this application' },
    NOT_FOUND: { status: 404, message: 'unavailable' },
    INVALID_REQUEST: { status: 400, message: 'invalid publish request' },
    NOT_READY: { status: 409, message: 'conflict' },
    UNAVAILABLE: { status: 503, message: 'temporarily unavailable' },
  })
  .noMcp({ reason: 'Connected applications call this over /app-rpc with their grant' })
  .noCli({ reason: 'There is no CLI for connected applications' })
  .handler(async ({ env, ctx, input, fail }) => {
    try {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the callee validates the artifact at runtime
      return await requestPublishApproval(ctx.db, env, ctx.grant, input as PublishRequestBody);
    } catch (error) {
      const refusal = previewRefusal(error);
      if (refusal) {
        return fail(refusal.code, refusal.message);
      }
      throw error;
    }
  });
