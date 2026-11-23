import { describe, expect, it } from 'vite-plus/test';
import { platformConnectCommand } from '../../src/platform-identity.ts';

describe('platformConnectCommand', () => {
  it.each([
    ['https://api.example.com', "bwf connect 'api.example.com'"],
    ['https://api.example.com:8443', "bwf connect 'api.example.com:8443'"],
    ['http://localhost:8787', "bwf connect 'localhost:8787'"],
    ['http://127.0.0.1:8787', "bwf connect '127.0.0.1:8787'"],
    ['http://[::1]:8787', "bwf connect '[::1]:8787'"],
    ['https://localhost:8787', "bwf connect 'https://localhost:8787'"],
    ["https://a'b.example.com", String.raw`bwf connect 'a'\''b.example.com'`],
  ])('generates a copyable command for %s', (url, command) => {
    expect(platformConnectCommand(url)).toBe(command);
  });
});
