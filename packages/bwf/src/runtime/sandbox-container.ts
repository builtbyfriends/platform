import { Files } from '@cloudflare/sandbox';
import { DurableObject, RpcTarget, WorkerEntrypoint } from 'cloudflare:workers';

export type SandboxInstance =
  | 'lite'
  | 'basic'
  | 'standard-1'
  | 'standard-2'
  | 'standard-3'
  | 'standard-4';
export type SandboxSecret = {
  /** Hostnames or `*` patterns the header is added for. Sent over HTTPS only. */
  hosts: Array<string>;
  header: string;
  value: string;
};
export type SandboxOutbound = {
  /** `full` reaches any host, `hosts` only the listed ones, `none` nothing but the secrets' hosts. */
  mode: 'full' | 'hosts' | 'none';
  hosts?: Array<string>;
  secrets?: Array<SandboxSecret>;
};
export type SandboxOptions = {
  inactivityTimeoutMs?: number;
  enableInternet?: boolean;
  labels?: Record<string, string>;
  /** HTTP and HTTPS rules for the sandbox. Secrets are added outside the container, so code in it can't read them. */
  outbound?: SandboxOutbound;
};
export type SandboxExecOptions = ContainerExecOptions & {
  signal?: AbortSignal;
  pty?: boolean | { cols?: number; rows?: number };
};
export type SandboxCapability = {
  invoke(operation: string, args: Array<unknown>): Promise<unknown>;
};
export const SANDBOX_PORT_HEADER = 'x-platform-sandbox-port';
export type SandboxProcessWire = {
  capability: SandboxCapability;
  pid: number;
  isPty: boolean;
  stdin: WritableStream | null;
  stdout: ReadableStream | null;
  stderr: ReadableStream | null;
};
// Decision: The public SDK also supports consumers on workers-types 4.x, which predates
// image selection, abort signals and PTYs on the native Container API.
export type SandboxNativeContainer = Omit<Container, 'start' | 'exec'> & {
  readonly images: Record<string, string>;
  start(options: {
    image: string;
    instance: SandboxInstance;
    enableInternet: boolean;
    labels?: Record<string, string>;
    entrypoint?: Array<string>;
  }): void;
  exec(
    argv: Array<string>,
    options?: SandboxExecOptions,
  ): Promise<ExecProcess & { isPty?: boolean; resize(cols: number, rows: number): void }>;
};

const OPTIONS = new Set(['inactivityTimeoutMs', 'enableInternet', 'labels', 'outbound']);
const FILE_OPERATIONS = new Set<keyof Files>([
  'readFile',
  'writeFile',
  'stat',
  'lstat',
  'readDirectory',
  'mkdir',
  'rename',
  'remove',
]);
export const DEFAULT_SANDBOX_INACTIVITY_TIMEOUT_MS: number = 10 * 60 * 1000;

export function validateSandboxOptions(options: SandboxOptions): void {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Sandbox options must be an object.');
  }
  for (const key of Object.keys(options)) {
    if (!OPTIONS.has(key)) {
      throw new TypeError(`Unsupported Sandbox option: ${key}`);
    }
  }
  if (
    options.inactivityTimeoutMs !== undefined &&
    (!Number.isInteger(options.inactivityTimeoutMs) ||
      options.inactivityTimeoutMs < 1 ||
      options.inactivityTimeoutMs > 6 * 60 * 60 * 1000)
  ) {
    throw new TypeError('Sandbox inactivityTimeoutMs must be an integer between 1 and 21600000.');
  }
  if (options.enableInternet !== undefined && typeof options.enableInternet !== 'boolean') {
    throw new TypeError('Sandbox enableInternet must be a boolean.');
  }
  if (
    options.labels !== undefined &&
    (!options.labels ||
      typeof options.labels !== 'object' ||
      Array.isArray(options.labels) ||
      Object.values(options.labels).some((value) => typeof value !== 'string'))
  ) {
    throw new TypeError('Sandbox labels must be strings.');
  }
  if (options.outbound !== undefined) {
    validateOutbound(options.outbound);
    if (options.enableInternet !== undefined) {
      throw new TypeError('Use outbound.mode instead of enableInternet with outbound rules.');
    }
  }
}

const HOST_PATTERN =
  /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$|^\*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MAX_OUTBOUND_HOSTS = 200;
const MAX_OUTBOUND_SECRETS = 50;

function validHosts(hosts: unknown, label: string): asserts hosts is Array<string> {
  if (
    !Array.isArray(hosts) ||
    hosts.length > MAX_OUTBOUND_HOSTS ||
    hosts.some((host) => typeof host !== 'string' || !HOST_PATTERN.test(host))
  ) {
    throw new TypeError(
      `Sandbox ${label} must be at most ${MAX_OUTBOUND_HOSTS} lower-case hostnames, each optionally starting with *.`,
    );
  }
}

function validateOutbound(outbound: SandboxOutbound): void {
  if (!outbound || typeof outbound !== 'object' || Array.isArray(outbound)) {
    throw new TypeError('Sandbox outbound must be an object.');
  }
  for (const key of Object.keys(outbound)) {
    if (!['mode', 'hosts', 'secrets'].includes(key)) {
      throw new TypeError(`Unsupported Sandbox outbound option: ${key}`);
    }
  }
  if (!['full', 'hosts', 'none'].includes(outbound.mode)) {
    throw new TypeError('Sandbox outbound.mode must be full, hosts or none.');
  }
  if (outbound.hosts !== undefined) {
    validHosts(outbound.hosts, 'outbound.hosts');
  }
  if (outbound.mode === 'hosts' && !outbound.hosts?.length) {
    throw new TypeError('Sandbox outbound.mode hosts needs at least one host.');
  }
  const secrets: unknown = outbound.secrets;
  if (secrets === undefined) {
    return;
  }
  if (!Array.isArray(secrets) || secrets.length > MAX_OUTBOUND_SECRETS) {
    throw new TypeError(
      `Sandbox outbound.secrets must be at most ${MAX_OUTBOUND_SECRETS} entries.`,
    );
  }
  for (const secret of outbound.secrets ?? []) {
    if (!secret || typeof secret !== 'object') {
      throw new TypeError('Each Sandbox outbound secret must be an object.');
    }
    validHosts(secret.hosts, 'outbound secret hosts');
    if (!secret.hosts.length || secret.hosts.includes('*')) {
      throw new TypeError('Each Sandbox outbound secret needs named hosts, not *.');
    }
    if (typeof secret.header !== 'string' || !HEADER_NAME.test(secret.header)) {
      throw new TypeError('Each Sandbox outbound secret needs a valid header name.');
    }
    if (typeof secret.value !== 'string' || !secret.value || /[\r\n]/.test(secret.value)) {
      throw new TypeError('Each Sandbox outbound secret needs a one-line value.');
    }
  }
}

export function hostMatches(host: string, pattern: string): boolean {
  const name = host.toLowerCase().replace(/\.+$/, '');
  if (pattern === '*') {
    return true;
  }
  if (pattern.startsWith('*.')) {
    return name.endsWith(pattern.slice(1));
  }
  return name === pattern;
}

/** What the outbound handler decides for one request: block it, send it as is, or add a secret's header. */
export function outboundDecision(
  outbound: SandboxOutbound,
  url: URL,
):
  | { action: 'block'; reason: string }
  | { action: 'send' }
  | { action: 'secret'; secret: SandboxSecret } {
  const host = url.hostname;
  const secret = outbound.secrets?.find((entry) =>
    entry.hosts.some((pattern) => hostMatches(host, pattern)),
  );
  if (secret) {
    // Decision: A secret only goes over HTTPS, so a plain HTTP request to its host is refused instead of sent without it.
    return url.protocol === 'https:'
      ? { action: 'secret', secret }
      : {
          action: 'block',
          reason: `Use https:// for ${host}: its secret isn't sent over plain HTTP.`,
        };
  }
  if (outbound.mode === 'full') {
    return { action: 'send' };
  }
  if (outbound.mode === 'hosts' && outbound.hosts?.some((pattern) => hostMatches(host, pattern))) {
    return { action: 'send' };
  }
  return { action: 'block', reason: `This sandbox's network rules don't include ${host}.` };
}

/**
 * Applies a sandbox's `outbound` rules to its HTTP and HTTPS requests. Export it from the Worker that defines the Sandbox
 * Durable Object; `ctx.exports` needs it there.
 */
export class SandboxOutboundHandler extends WorkerEntrypoint<unknown, SandboxOutbound> {
  override async fetch(request: Request): Promise<Response> {
    const decision = outboundDecision(this.ctx.props, new URL(request.url));
    if (decision.action === 'block') {
      return new Response(`Blocked: ${decision.reason}\n`, {
        status: 403,
        headers: { 'content-type': 'text/plain' },
      });
    }
    if (decision.action === 'send') {
      return fetch(request);
    }
    const headers = new Headers(request.headers);
    headers.set(decision.secret.header, decision.secret.value);
    // Decision: A redirect isn't followed here, so the secret can't travel on to another host.
    return fetch(new Request(request, { headers, redirect: 'manual' }));
  }
}

const SANDBOX_CA = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';
// Decision: Best effort across images: Debian-style images take update-ca-certificates; others get the CA added to the bundle.
const TRUST_CA = `[ -f ${SANDBOX_CA} ] || exit 0; if command -v update-ca-certificates >/dev/null 2>&1; then mkdir -p /usr/local/share/ca-certificates && cp ${SANDBOX_CA} /usr/local/share/ca-certificates/cloudflare-containers-ca.crt && update-ca-certificates >/dev/null 2>&1; else for b in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/cert.pem; do [ -f "$b" ] && cat ${SANDBOX_CA} >> "$b" && break; done; fi`;

class ProcessCapability extends RpcTarget {
  #process: ExecProcess & { resize(cols: number, rows: number): void };
  #exited = false;
  #waitForExit: () => Promise<number>;
  constructor(
    process: ExecProcess & { resize(cols: number, rows: number): void },
    waitForExit: () => Promise<number>,
  ) {
    super();
    this.#process = process;
    this.#waitForExit = waitForExit;
    void process.exitCode.then(
      () => {
        this.#exited = true;
      },
      () => {
        this.#exited = true;
      },
    );
  }
  async invoke(operation: string, args: Array<unknown>): Promise<unknown> {
    if (!Array.isArray(args)) {
      throw new TypeError('Sandbox arguments must be an array.');
    }
    if (operation === 'exitCode') {
      return this.#waitForExit();
    }
    if (operation === 'kill') {
      if (this.#exited) {
        return;
      }
      return this.#process.kill(args[0] as number | undefined);
    }
    if (operation === 'resize') {
      return this.#process.resize(args[0] as number, args[1] as number);
    }
    throw new TypeError(`Unsupported Sandbox process operation: ${operation}`);
  }
}

/** Decode cancellation without trying to serialize an AbortSignal over Workers RPC. */
function operationOptions(value: unknown): { options: Record<string, unknown>; finish(): void } {
  const { abort, ...options } = (value ?? {}) as Record<string, unknown>;
  if (abort === undefined) {
    return { options, finish() {} };
  }
  if (!(abort instanceof ReadableStream)) {
    throw new TypeError('Invalid Sandbox cancellation stream.');
  }
  const controller = new AbortController();
  const reader = abort.getReader();
  let finished = false;
  void reader.read().then(
    () => {
      if (!finished) {
        controller.abort();
      }
    },
    () => {
      if (!finished) {
        controller.abort();
      }
    },
  );
  return {
    options: { ...options, signal: controller.signal },
    finish() {
      finished = true;
      void reader.cancel().catch(() => {});
    },
  };
}

/** Shared native execution, used by local Workers and the trusted platform controller. */
export class SandboxContainer<Env = unknown> extends DurableObject<Env> {
  protected instanceType: SandboxInstance = 'lite';
  #setup: Promise<void> | undefined;
  #options: SandboxOptions = {};
  #ready: Promise<void>;
  protected starting = false;
  #epoch = 0;

  // Decision: WebSockets must travel through DO fetch, since RPC cannot serialize them.
  async fetch(request: Request): Promise<Response> {
    const value = request.headers.get(SANDBOX_PORT_HEADER);
    if (!value || !/^\d+$/.test(value)) {
      return new Response('Invalid Sandbox TCP port.', { status: 400 });
    }
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return new Response('Invalid Sandbox TCP port.', { status: 400 });
    }
    const headers = new Headers(request.headers);
    headers.delete(SANDBOX_PORT_HEADER);
    await this.ensureRunning();
    return this.container.getTcpPort(port).fetch(new Request(request, { headers }));
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Decision: Inactivity timeouts are not retained across Durable Object restarts.
    this.#ready = ctx.blockConcurrencyWhile(async () => {
      this.#options = (await ctx.storage.get<SandboxOptions>('__platformSandboxOptions')) ?? {};
      if (this.container.running) {
        await this.container.setInactivityTimeout(this.inactivityTimeoutMs);
      }
    });
  }

  protected get container(): SandboxNativeContainer {
    if (!this.ctx.container) {
      throw new Error('Sandbox container binding is missing.');
    }
    return this.ctx.container;
  }

  async configure(options: SandboxOptions): Promise<void> {
    validateSandboxOptions(options);
    await this.#ready;
    const before = this.#options;
    this.#options = { ...options };
    await this.ctx.storage.put('__platformSandboxOptions', this.#options);
    if (!this.container.running) {
      return;
    }
    // Decision: Internet access is fixed when a container starts, so a change to it, or to whether rules apply at all, restarts the
    // container on its next use. Other rule changes replace the intercepts' handler in place.
    if (
      Boolean(before.outbound) !== Boolean(options.outbound) ||
      this.#internet(before) !== this.#internet(options)
    ) {
      await this.destroy();
      return;
    }
    await this.container.setInactivityTimeout(this.inactivityTimeoutMs);
    if (options.outbound && JSON.stringify(before.outbound) !== JSON.stringify(options.outbound)) {
      await this.#intercept(options.outbound);
    }
  }

  #internet(options: SandboxOptions): boolean {
    return options.outbound ? options.outbound.mode === 'full' : (options.enableInternet ?? false);
  }

  async #intercept(outbound: SandboxOutbound): Promise<void> {
    const exports = this.ctx.exports as {
      SandboxOutboundHandler?: (options: { props: SandboxOutbound }) => Fetcher;
    };
    if (!exports.SandboxOutboundHandler) {
      throw new Error(
        'Sandbox outbound rules need SandboxOutboundHandler exported from the Worker that defines the Sandbox.',
      );
    }
    const handler = exports.SandboxOutboundHandler({ props: outbound });
    await this.container.interceptAllOutboundHttp(handler);
    await this.container.interceptOutboundHttps('*', handler);
  }

  protected get inactivityTimeoutMs(): number {
    return this.#options.inactivityTimeoutMs ?? DEFAULT_SANDBOX_INACTIVITY_TIMEOUT_MS;
  }
  protected async beforeStart(): Promise<void> {}
  protected async afterStart(): Promise<void> {}
  protected async beforeUse(): Promise<void> {}
  protected async stopped(): Promise<void> {}
  protected processContext(_exitCode: Promise<number>): unknown {
    return undefined;
  }
  protected async waitForProcessExit(
    exitCode: Promise<number>,
    _context?: unknown,
  ): Promise<number> {
    return exitCode;
  }

  /** Native abort listeners must be detached as soon as a process exits. */
  protected async execProcess(
    argv: Array<string>,
    options: SandboxExecOptions = {},
  ): Promise<ExecProcess & { isPty?: boolean; resize(cols: number, rows: number): void }> {
    const { signal, ...nativeOptions } = options;
    if (!signal) {
      return this.container.exec(argv, nativeOptions);
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener('abort', abort, { once: true });
    }
    const finish = () => signal.removeEventListener('abort', abort);
    try {
      const process = await this.container.exec(argv, {
        ...nativeOptions,
        signal: controller.signal,
      });
      void process.exitCode.then(finish, finish);
      return process;
    } catch (error) {
      finish();
      throw error;
    }
  }

  protected async initializationOutput(
    argv: Array<string>,
    options: SandboxExecOptions,
    timeoutMs: number,
  ): Promise<ExecOutput> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const finish = () => clearTimeout(timer);
    try {
      const process = await this.execProcess(argv, { ...options, signal: controller.signal });
      void process.exitCode.then(finish, finish);
      return await process.output();
    } finally {
      finish();
    }
  }
  protected async initialize(): Promise<void> {
    // Decision: exec waits for boot readiness; `running` alone is true before boot finishes.
    const result = await this.initializationOutput(['sh', '-c', 'mkdir -p /workspace'], {}, 60_000);
    if (result.exitCode !== 0) {
      throw new Error('Sandbox workspace initialization failed.');
    }
    if (this.#options.outbound) {
      await this.initializationOutput(['sh', '-c', TRUST_CA], {}, 30_000);
    }
  }
  protected get entrypoint(): Array<string> | undefined {
    return undefined;
  }
  protected get image(): string {
    return this.container.images.default;
  }

  protected async ensureRunning(): Promise<void> {
    if (!this.#setup || (!this.container.running && !this.starting)) {
      this.starting = true;
      this.#setup = this.setup(this.#epoch)
        .catch((error) => {
          this.#setup = undefined;
          throw error;
        })
        .finally(() => {
          this.starting = false;
        });
    }
    await this.#setup;
    await this.beforeUse();
  }
  private async setup(epoch: number): Promise<void> {
    await this.#ready;
    try {
      await this.beforeStart();
      if (epoch !== this.#epoch) {
        throw new Error('Sandbox startup was cancelled.');
      }
      if (!this.container.running) {
        if (this.#options.outbound) {
          // Decision: HTTPS intercepts go in before start, so the container's CA file exists when it boots.
          await this.#intercept(this.#options.outbound);
        }
        this.container.start({
          image: this.image,
          instance: this.instanceType,
          enableInternet: this.#internet(this.#options),
          labels: this.#options.labels,
          ...(this.entrypoint ? { entrypoint: this.entrypoint } : {}),
        });
      }
      // Decision: Startup returns before the VM is ready. Retain it while initialization
      // waits for boot; setting the timeout afterwards can lose the VM first.
      await this.container.setInactivityTimeout(this.inactivityTimeoutMs);
      await this.initialize();
      if (epoch !== this.#epoch) {
        throw new Error('Sandbox startup was cancelled.');
      }
      await this.afterStart();
    } catch (error) {
      // Decision: Readiness, admission and initialization must all succeed before use.
      await this.destroy().catch(() => {});
      throw error;
    }
  }

  async destroy(): Promise<void> {
    this.#epoch++;
    if (this.container.running) {
      await this.container.destroy();
    }
    if (this.container.running) {
      throw new Error('PLATFORM_SANDBOX_unavailable');
    }
    if (!this.starting) {
      this.#setup = undefined;
    }
    await this.stopped();
  }

  async invoke(operation: string, args: Array<unknown>): Promise<unknown> {
    if (!Array.isArray(args)) {
      throw new TypeError('Sandbox arguments must be an array.');
    }
    if (operation === 'destroy') {
      return this.destroy();
    }
    if (operation === 'running') {
      return this.container.running;
    }
    if (operation === 'files') {
      const [method, ...parameters] = args;
      if (!FILE_OPERATIONS.has(method as keyof Files)) {
        throw new TypeError(`Unsupported Sandbox file operation: ${String(method)}`);
      }
      await this.ensureRunning();
      const index = method === 'writeFile' || method === 'rename' ? 2 : 1;
      const { options, finish } = operationOptions(parameters[index]);
      parameters[index] = options;
      try {
        const files = new Files({ exec: (argv, options) => this.execProcess(argv, options) });
        const target = files[method as keyof Files] as (
          ...args: Array<unknown>
        ) => Promise<unknown>;
        const result = await target.apply(files, parameters);
        if (result instanceof Response && result.body) {
          const reader = result.body.getReader();
          return new Response(
            new ReadableStream({
              async pull(controller) {
                try {
                  const chunk = await reader.read();
                  if (chunk.done) {
                    finish();
                    controller.close();
                  } else {
                    controller.enqueue(chunk.value);
                  }
                } catch (error) {
                  finish();
                  controller.error(error);
                }
              },
              async cancel(reason) {
                finish();
                await reader.cancel(reason);
              },
            }),
            result,
          );
        }
        finish();
        return result;
      } catch (error) {
        finish();
        throw error;
      }
    }
    if (operation === 'exec') {
      const [argv, value] = args;
      if (
        !Array.isArray(argv) ||
        argv.length === 0 ||
        argv.some((arg) => typeof arg !== 'string')
      ) {
        throw new TypeError(
          'Sandbox exec requires an executable and arguments as an array of strings.',
        );
      }
      const { options, finish } = operationOptions(value);
      try {
        await this.ensureRunning();
        const process = await this.execProcess(argv, { cwd: '/workspace', ...options });
        void process.exitCode.then(finish, finish);
        const processContext = this.processContext(process.exitCode);
        return {
          capability: new ProcessCapability(process, () =>
            this.waitForProcessExit(process.exitCode, processContext),
          ),
          pid: process.pid,
          isPty: process.isPty ?? false,
          stdin: process.stdin ?? null,
          stdout: process.stdout ?? null,
          stderr: process.stderr ?? null,
        } satisfies SandboxProcessWire;
      } catch (error) {
        finish();
        throw error;
      }
    }
    if (operation === 'fetch') {
      const [port, request] = args;
      if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65_535) {
        throw new TypeError('Invalid Sandbox TCP port.');
      }
      await this.ensureRunning();
      return this.container.getTcpPort(port as number).fetch(request as Request);
    }
    throw new TypeError(`Unsupported Sandbox operation: ${operation}`);
  }
}
