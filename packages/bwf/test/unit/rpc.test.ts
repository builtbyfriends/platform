import { describe, expect, it, vi } from 'vite-plus/test';
import { createRpc, RpcError, rpcName } from '../../src/runtime/rpc.ts';

function respond(body: unknown, status = 200) {
  return vi.fn(async (_url: string, _init?: RequestInit) => Response.json(body, { status }));
}

describe('createRpc', () => {
  it('posts nested names to /rpc/<name> and unwraps data', async () => {
    const fetchMock = respond({ data: ['inv_1'] });
    const rpc = createRpc({ baseUrl: 'https://app.test', fetch: fetchMock as typeof fetch });
    const call = rpc as unknown as {
      billing: { invoices: { list(input: object): Promise<unknown> } };
    };

    await expect(call.billing.invoices.list({ limit: 5 })).resolves.toEqual(['inv_1']);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://app.test/rpc/billing.invoices.list');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ limit: 5 }));
  });

  it('sends a token as a bearer credential', async () => {
    const fetchMock = respond({ data: null });
    const rpc = createRpc({ token: () => 'secret', fetch: fetchMock as typeof fetch });
    await (rpc as unknown as { me: { get(): Promise<unknown> } }).me.get();
    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer secret');
    expect(fetchMock.mock.calls[0]![0]).toBe('/rpc/me.get');
  });

  it('throws an RpcError that keeps the declared code and status', async () => {
    const rpc = createRpc({
      fetch: respond(
        { error: { code: 'NOT_FOUND', message: 'No such contact' } },
        404,
      ) as typeof fetch,
    });
    const error = await (
      rpc as unknown as { contacts: { get(input: object): Promise<unknown> } }
    ).contacts
      .get({ id: 'x' })
      .catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(RpcError);
    expect(error).toMatchObject({ code: 'NOT_FOUND', status: 404, message: 'No such contact' });
  });

  it('names the procedure a call stands for', () => {
    const rpc = createRpc() as unknown as { contacts: { get: unknown } };
    expect(rpcName(rpc.contacts.get)).toBe('contacts.get');
    expect(rpcName(() => {})).toBeUndefined();
  });
});
