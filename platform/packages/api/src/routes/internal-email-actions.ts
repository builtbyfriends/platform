import { type Context, Hono } from 'hono';
import { hmacVerifyState } from '../auth/hmac.ts';
import {
  admitEmailAction,
  claimRelayedEmailReceipt,
  completeRelayedEmailReceipt,
  type EmailReceiptRouteFence,
  EmailAdmissionError,
  recordEmailReceipt,
  transitionEmailRecipients,
} from '../email/admission.ts';
import type { EmailAdmissionInput } from '../email/admission.ts';
import type { ApiEnv } from '../env.ts';

type EmailActionEnv = {
  Bindings: ApiEnv['Bindings'];
  Variables: ApiEnv['Variables'] & { emailActionBody: unknown };
};

const app = new Hono<EmailActionEnv>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is Array<string> {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isActionKind(value: unknown): value is EmailAdmissionInput['kind'] {
  return value === 'direct' || value === 'forward' || value === 'reply';
}

function isActionTransport(value: unknown): value is EmailAdmissionInput['transport'] {
  return (
    value === 'binding' ||
    value === 'send_raw' ||
    value === 'native_forward' ||
    value === 'native_reply'
  );
}

type RecipientOutcome = 'provider_accepted' | 'failed' | 'outcome_unknown' | 'cancelled';

function isRecipientOutcome(value: unknown): value is RecipientOutcome {
  return (
    value === 'provider_accepted' ||
    value === 'failed' ||
    value === 'outcome_unknown' ||
    value === 'cancelled'
  );
}

app.use('*', async (context, next) => {
  const signature = context.req.header('x-platform-internal');
  if (!signature) {
    return context.json({ error: 'invalid internal auth' }, 403);
  }
  if (Number(context.req.header('content-length')) > 32_768) {
    void context.req.raw.body?.cancel().catch(() => {});
    return context.json({ error: 'action request too large' }, 413);
  }
  const reader = context.req.raw.body?.getReader();
  if (!reader) {
    return context.json({ error: 'invalid body' }, 400);
  }
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  const deadline = Date.now() + 5_000;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error('action request timed out');
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('action request timed out')), remaining);
        }),
      ]).finally(() => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      });
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > 32_768) {
        void reader.cancel().catch(() => {});
        return context.json({ error: 'action request too large' }, 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'action request timed out') {
      return context.json({ error: 'action request timed out' }, 408);
    }
    throw error;
  } finally {
    void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // Decision: releaseLock can throw while a timed-out read is still settling after cancel.
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return context.json({ error: 'invalid body' }, 400);
  }
  if (
    !context.env.EMAIL_SIGNING_SECRET ||
    !(await hmacVerifyState(raw, signature, context.env.EMAIL_SIGNING_SECRET))
  ) {
    return context.json({ error: 'invalid internal auth' }, 403);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return context.json({ error: 'invalid body' }, 400);
  }
  context.set('emailActionBody', body);
  await next();
});

function admissionErrorResponse(context: Context<EmailActionEnv>, error: unknown): Response {
  if (!(error instanceof EmailAdmissionError)) {
    throw error;
  }
  const status =
    error.code === 'NOT_FOUND'
      ? 404
      : error.code === 'CONFLICT' || error.code === 'INVALID_STATE'
        ? 409
        : 400;
  return context.json({ error: error.message, code: error.code }, status);
}

function receiptRoute(value: unknown): EmailReceiptRouteFence | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const route = value;
  if (
    typeof route.routeId !== 'string' ||
    typeof route.routeGeneration !== 'number' ||
    typeof route.connectionId !== 'string' ||
    (route.addressing !== 'shared' && route.addressing !== 'custom') ||
    typeof route.domain !== 'string' ||
    typeof route.projectSlug !== 'string'
  ) {
    return undefined;
  }
  return {
    routeId: route.routeId,
    routeGeneration: route.routeGeneration,
    connectionId: route.connectionId,
    addressing: route.addressing,
    domain: route.domain,
    projectSlug: route.projectSlug,
  };
}

app.post('/admit', async (context) => {
  const body = context.get('emailActionBody');
  if (
    !isRecord(body) ||
    typeof body.projectId !== 'string' ||
    typeof body.key !== 'string' ||
    typeof body.digest !== 'string' ||
    typeof body.from !== 'string' ||
    !isStringArray(body.recipients) ||
    !isActionKind(body.kind) ||
    !isActionTransport(body.transport) ||
    (body.receiptId !== undefined && typeof body.receiptId !== 'string')
  ) {
    return context.json({ error: 'invalid admission request' }, 400);
  }
  try {
    return context.json(
      await admitEmailAction(context.get('db'), {
        projectId: body.projectId,
        kind: body.kind,
        key: body.key,
        digest: body.digest,
        from: body.from,
        recipients: body.recipients,
        transport: body.transport,
        ...(body.receiptId === undefined ? {} : { receiptId: body.receiptId }),
        sharedSenderDomain: context.env.EMAIL_SENDER_DOMAIN ?? '',
      }),
    );
  } catch (error) {
    return admissionErrorResponse(context, error);
  }
});

app.post('/receipts', async (context) => {
  const body = context.get('emailActionBody');
  if (
    !isRecord(body) ||
    typeof body.receiptId !== 'string' ||
    typeof body.projectId !== 'string' ||
    typeof body.status !== 'string'
  ) {
    return context.json({ error: 'invalid receipt' }, 400);
  }
  try {
    const route = receiptRoute(body.route);
    if (body.route !== undefined && !route) {
      return context.json({ error: 'invalid receipt' }, 400);
    }
    await recordEmailReceipt(context.get('db'), {
      receiptId: body.receiptId,
      projectId: body.projectId,
      status: body.status,
      ...(route ? { route } : {}),
    });
    return context.json({ ok: true });
  } catch (error) {
    return admissionErrorResponse(context, error);
  }
});

app.post('/receipts/claim', async (context) => {
  const body = context.get('emailActionBody');
  if (
    !isRecord(body) ||
    typeof body.receiptId !== 'string' ||
    typeof body.projectId !== 'string' ||
    typeof body.payloadDigest !== 'string'
  ) {
    return context.json({ error: 'invalid relay claim' }, 400);
  }
  try {
    const route = receiptRoute(body.route);
    if (body.route !== undefined && !route) {
      return context.json({ error: 'invalid relay claim' }, 400);
    }
    return context.json(
      await claimRelayedEmailReceipt(context.get('db'), {
        receiptId: body.receiptId,
        projectId: body.projectId,
        payloadDigest: body.payloadDigest,
        ...(route ? { route } : {}),
      }),
    );
  } catch (error) {
    return admissionErrorResponse(context, error);
  }
});

app.post('/receipts/complete', async (context) => {
  const body = context.get('emailActionBody');
  if (
    !isRecord(body) ||
    typeof body.receiptId !== 'string' ||
    typeof body.projectId !== 'string' ||
    typeof body.payloadDigest !== 'string' ||
    typeof body.reject !== 'boolean'
  ) {
    return context.json({ error: 'invalid relay completion' }, 400);
  }
  try {
    await completeRelayedEmailReceipt(context.get('db'), {
      receiptId: body.receiptId,
      projectId: body.projectId,
      payloadDigest: body.payloadDigest,
      reject: body.reject,
    });
    return context.json({ ok: true });
  } catch (error) {
    return admissionErrorResponse(context, error);
  }
});

app.post('/:id/start', async (context) => {
  const body = context.get('emailActionBody');
  if (!isRecord(body) || !isStringArray(body.recipients)) {
    return context.json({ error: 'invalid recipients' }, 400);
  }
  try {
    return context.json({
      recipients: await transitionEmailRecipients(
        context.get('db'),
        context.req.param('id'),
        body.recipients,
        'attempt_started',
      ),
    });
  } catch (error) {
    return admissionErrorResponse(context, error);
  }
});

app.post('/:id/finish', async (context) => {
  const body = context.get('emailActionBody');
  if (
    !isRecord(body) ||
    !isStringArray(body.recipients) ||
    !isRecipientOutcome(body.state) ||
    (body.providerReference !== undefined && typeof body.providerReference !== 'string') ||
    (body.errorCode !== undefined && typeof body.errorCode !== 'string')
  ) {
    return context.json({ error: 'invalid outcome' }, 400);
  }
  try {
    return context.json({
      recipients: await transitionEmailRecipients(
        context.get('db'),
        context.req.param('id'),
        body.recipients,
        body.state,
        {
          providerReference: body.providerReference,
          errorCode: body.errorCode,
        },
      ),
    });
  } catch (error) {
    return admissionErrorResponse(context, error);
  }
});

export default app;
