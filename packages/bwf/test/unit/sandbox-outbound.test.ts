import { describe, expect, it, vi } from 'vite-plus/test';
vi.mock('@cloudflare/sandbox', () => ({ Files: class {} }));
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
import {
  hostMatches,
  outboundDecision,
  validateSandboxOptions,
} from '../../src/runtime/sandbox-container.ts';
import type { SandboxOutbound } from '../../src/runtime/sandbox-container.ts';

const url = (value: string) => new URL(value);
const secret = { hosts: ['api.example.com'], header: 'authorization', value: 'Bearer s' };

describe('Sandbox outbound rules', () => {
  it('matches exact hosts, subdomain patterns and *', () => {
    expect(hostMatches('api.example.com', 'api.example.com')).toBe(true);
    expect(hostMatches('API.example.com.', 'api.example.com')).toBe(true);
    expect(hostMatches('a.b.example.com', '*.example.com')).toBe(true);
    expect(hostMatches('example.com', '*.example.com')).toBe(false);
    expect(hostMatches('evil-example.com', '*.example.com')).toBe(false);
    expect(hostMatches('anything.dev', '*')).toBe(true);
  });

  it('sends, blocks or adds a secret by mode and host', () => {
    const hosts: SandboxOutbound = { mode: 'hosts', hosts: ['*.npmjs.org'], secrets: [secret] };
    expect(outboundDecision(hosts, url('https://registry.npmjs.org/x'))).toEqual({
      action: 'send',
    });
    expect(outboundDecision(hosts, url('https://other.dev/'))).toMatchObject({ action: 'block' });
    expect(outboundDecision(hosts, url('https://api.example.com/v1'))).toEqual({
      action: 'secret',
      secret,
    });
    expect(outboundDecision({ mode: 'none' }, url('https://registry.npmjs.org/'))).toMatchObject({
      action: 'block',
    });
    expect(outboundDecision({ mode: 'full' }, url('http://any.dev/'))).toEqual({ action: 'send' });
  });

  it("refuses to send a secret's host over plain HTTP", () => {
    expect(
      outboundDecision({ mode: 'full', secrets: [secret] }, url('http://api.example.com/')),
    ).toMatchObject({
      action: 'block',
    });
  });

  it('validates the rules', () => {
    expect(() =>
      validateSandboxOptions({ outbound: { mode: 'hosts', hosts: ['ok.dev'] } }),
    ).not.toThrow();
    expect(() => validateSandboxOptions({ outbound: { mode: 'hosts' } })).toThrow(
      'at least one host',
    );
    expect(() => validateSandboxOptions({ outbound: { mode: 'open' as never } })).toThrow('mode');
    expect(() =>
      validateSandboxOptions({ outbound: { mode: 'full', hosts: ['Bad Host'] } }),
    ).toThrow('hostnames');
    expect(() =>
      validateSandboxOptions({
        outbound: { mode: 'full', secrets: [{ ...secret, hosts: ['*'] }] },
      }),
    ).toThrow('named hosts');
    expect(() =>
      validateSandboxOptions({
        outbound: { mode: 'full', secrets: [{ ...secret, value: 'a\nb' }] },
      }),
    ).toThrow('one-line');
    expect(() =>
      validateSandboxOptions({ outbound: { mode: 'full' }, enableInternet: true }),
    ).toThrow('outbound.mode');
  });
});
