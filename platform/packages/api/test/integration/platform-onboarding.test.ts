import { PLATFORM_DISABLED_KEY, PLATFORM_DISABLED_VALUE } from '@builtbyfriends/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import app from '../../src/index.ts';
import { adminHtml } from '../helpers/admin-html.tsx';
import { setupEnv, teardownEnv } from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await teardownEnv();
});

describe('platform onboarding pages', () => {
  it('welcomes visitors at the API root with this platform’s connection instructions', async () => {
    const response = await app.fetch(
      new Request('https://alias.example.com/', {
        headers: { 'X-Forwarded-Host': 'attacker.example', 'X-Forwarded-Proto': 'http' },
      }),
      {
        ...env,
        AUTH_REDIRECT_URI: 'https://api.example.com/auth/callback',
        PLATFORM_DISPLAY_NAME: '<Example Platform>',
        PLATFORM_INSTALLATION_ID: 'example-installation',
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const html = await adminHtml(response);
    expect(html).toContain('<h1 id="platform-auth-title">Welcome to &lt;Example Platform&gt;</h1>');
    expect(html).toContain('<title>Welcome · &lt;Example Platform&gt;</title>');
    expect(html).toContain('npm install -g void');
    expect(html).toContain('bwf connect &#39;api.example.com&#39;');
    expect(html).toContain('href="/admin/"');
    expect(html).toContain(
      'href="https://github.com/builtbyfriends/platform/blob/main/docs/guide/quickstart.md"',
    );
    expect(html).not.toContain('<Example Platform>');
    expect(html).not.toContain('attacker.example');
    expect(html).not.toContain('alias.example.com');
    expect(html).not.toContain('<script');
  });

  it('keeps the welcome page behind the installation traffic gate', async () => {
    await env.ROUTING.put(PLATFORM_DISABLED_KEY, PLATFORM_DISABLED_VALUE);
    try {
      const response = await app.fetch(new Request('https://api.example.com/'), {
        ...env,
        PLATFORM_INSTALLATION_ID: 'example-installation',
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'Platform disabled' });
    } finally {
      await env.ROUTING.delete(PLATFORM_DISABLED_KEY);
    }
  });

  it('shows the configured platform identity and connection, ignoring forwarded origins', async () => {
    const response = await app.fetch(
      new Request('https://alias.example.com/invite', {
        headers: {
          Host: 'attacker.example',
          'X-Forwarded-Host': 'attacker.example',
          'X-Forwarded-Proto': 'http',
        },
      }),
      {
        ...env,
        AUTH_REDIRECT_URI: 'https://api.example.com/auth/callback',
        PLATFORM_DISPLAY_NAME: '<Example Platform>',
        PLATFORM_INSTALLATION_ID: 'example-installation',
      },
    );
    expect(response.status).toBe(200);
    const html = await adminHtml(response);
    expect(html).toContain('&lt;Example Platform&gt;');
    expect(html).toContain('<title>Get Started · &lt;Example Platform&gt;</title>');
    expect(html).not.toContain('<Example Platform>');
    // Decision: `escapeHtml` escapes the quotes too. The browser renders them back.
    expect(html).toContain('bwf connect &#39;api.example.com&#39;');
    expect(html).not.toContain('attacker.example');
    expect(html).not.toContain('alias.example.com');
    expect(html).not.toContain('bwf auth login');
    expect(html).not.toContain('bwf deploy');
    expect(html).toContain('bwf project link');
    expect(html).not.toMatch(/private beta|discord|early-access/i);
  });

  it('uses the actual API request origin when no callback is configured', async () => {
    const response = await app.fetch(
      new Request('https://api.example.com/invite', {
        headers: { Host: 'attacker.example', 'X-Forwarded-Host': 'attacker.example' },
      }),
      { ...env, PLATFORM_INSTALLATION_ID: 'example-installation' },
    );
    const html = await adminHtml(response);
    expect(html).toContain('Get Started with Platform');
    // Decision: `escapeHtml` escapes the quotes too. The browser renders them back.
    expect(html).toContain('bwf connect &#39;api.example.com&#39;');
    expect(html).not.toContain('attacker.example');
  });

  it('turns a project invitation link into CLI acceptance instructions', async () => {
    const response = await app.fetch(
      new Request('https://api.example.com/invite?project-invitation=pinv_a1b2c3d4e5f6'),
      {
        ...env,
        AUTH_REDIRECT_URI: 'https://api.example.com/auth/callback',
        PLATFORM_INSTALLATION_ID: 'example-installation',
      },
    );

    expect(response.status).toBe(200);
    const html = await adminHtml(response);
    expect(html).toContain('<title>Accept Project Invitation · Platform</title>');
    expect(html).toContain('bwf connect &#39;api.example.com&#39;');
    expect(html).toContain('bwf project team accept pinv_a1b2c3d4e5f6');
    expect(html).toContain('The CLI checks that it is still valid');
    expect(html).toContain('run <code>bwf project link</code> if it is not linked yet');
    expect(html).toContain('use a separate checkout without a <code>.bwf/project.json</code>');
    expect(html).toContain('Accepting an invitation keeps existing project links.');
    expect(html).not.toContain('choose a project on this platform before deploying');
    expect(html).not.toContain('href="/admin');
  });

  it('does not render shell instructions for a malformed invitation id', async () => {
    const response = await app.fetch(
      new Request(
        'https://api.example.com/invite?project-invitation=%24%28open%20https%3A%2F%2Fevil.example%29',
      ),
      {
        ...env,
        AUTH_REDIRECT_URI: 'https://api.example.com/auth/callback',
        PLATFORM_INSTALLATION_ID: 'example-installation',
      },
    );

    expect(response.status).toBe(200);
    const html = await adminHtml(response);
    expect(html).toContain('<title>Get Started · Platform</title>');
    expect(html).not.toContain('bwf project team accept');
    expect(html).not.toContain('evil.example');
  });

  it.each(['/', '/invite', '/signup-restricted'])(
    'uses a generic name for source deployments at %s',
    async (path) => {
      const response = await app.fetch(
        new Request(`https://api.example.com${path}`, {
          headers: {
            Host: 'platform.buildwithfriends.dev',
            'X-Forwarded-Host': 'platform.buildwithfriends.dev',
          },
        }),
        env,
      );
      expect(response.status).toBe(200);
      const html = await adminHtml(response);
      // Decision: The hosted and the generic name are both "Platform", so check that the forwarded hosted origin
      // doesn't reach the page instead.
      expect(html).toContain('Platform');
      expect(html).not.toContain('platform.buildwithfriends.dev');
      if (path === '/') {
        expect(html).toContain('bwf connect &#39;api.example.com&#39;');
      }
    },
  );

  it.each(['https://platform.buildwithfriends.dev', 'https://api.staging.void.cloud'])(
    'preserves the hosted name at %s',
    async (origin) => {
      const response = await app.fetch(new Request(`${origin}/signup-restricted`), env);
      expect(await adminHtml(response)).toContain(
        'New accounts on Platform require administrator approval.',
      );
    },
  );

  it('explains administrator-controlled access without a private beta claim', async () => {
    const response = await app.fetch(new Request('https://api.example.com/signup-restricted'), {
      ...env,
      PLATFORM_DISPLAY_NAME: '<Example Platform>',
      PLATFORM_INSTALLATION_ID: 'example-installation',
    });
    expect(response.status).toBe(200);
    const html = await adminHtml(response);
    expect(html).toContain(
      'New accounts on &lt;Example Platform&gt; require administrator approval.',
    );
    expect(html).toContain('verified email address');
    expect(html).not.toMatch(/private beta|check back later/i);
  });
});
