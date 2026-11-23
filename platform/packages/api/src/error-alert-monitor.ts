import { DurableObject } from 'cloudflare:workers';
import { createDb, getUser, getProject } from './db.ts';
import { sendErrorAlertEmail } from './email.ts';
import type { ApiEnv } from './env.ts';

const DEBOUNCE_MS = 120_000;
const COUNT_CAP = 100;
const COOLDOWN_MS = 86_400_000;

type ErrorAlertState = {
  count: number;
  projectId: string;
  userId: string;
  slug: string;
  lastAlertAt: number | null;
  // Decision: Bounds of the errors counted in `count`. `firstErrorAt` persists across the cooldown so a burst
  // whose tail piled up while suppressed still reports its real start time in the alert email.
  firstErrorAt: number | null;
  lastErrorAt: number | null;
};

export class ErrorAlertMonitor extends DurableObject<ApiEnv['Bindings']> {
  private state: ErrorAlertState | null = null;

  private async getState(): Promise<ErrorAlertState> {
    if (this.state) {
      return this.state;
    }
    const stored = await this.ctx.storage.get<Partial<ErrorAlertState>>('state');
    // Decision: Spread over defaults so legacy state (no firstErrorAt/lastErrorAt) fills in null, not undefined.
    this.state = {
      count: 0,
      projectId: '',
      userId: '',
      slug: '',
      lastAlertAt: null,
      firstErrorAt: null,
      lastErrorAt: null,
      ...stored,
    };
    return this.state;
  }

  private async saveState(state: ErrorAlertState): Promise<void> {
    this.state = state;
    await this.ctx.storage.put('state', state);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/record') {
      return this.handleRecord(request);
    }
    return new Response('not found', { status: 404 });
  }

  private async handleRecord(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      projectId: string;
      count: number;
      userId: string;
      slug: string;
      // Decision: Edge enqueue times of the errors in this batch, carried from the usage queue. Absent only on
      // legacy in-flight calls, which fall back to ingest time.
      firstAt?: number;
      lastAt?: number;
    };

    const state = await this.getState();
    const now = Date.now();
    const firstAt = body.firstAt ?? now;
    const lastAt = body.lastAt ?? now;
    if (state.count === 0) {
      state.firstErrorAt = firstAt;
      state.lastErrorAt = lastAt;
    } else {
      // Decision: Widen with min/max instead of assigning: queue batches can arrive out of order, so a later batch
      // may report older errors. Legacy state (written before this field existed) leaves these null; keep
      // them null so the email says "recently" instead of a window that leaves out counted errors.
      if (state.firstErrorAt !== null) {
        state.firstErrorAt = Math.min(state.firstErrorAt, firstAt);
      }
      if (state.lastErrorAt !== null) {
        state.lastErrorAt = Math.max(state.lastErrorAt, lastAt);
      }
    }
    state.count += body.count;
    state.projectId = body.projectId;
    state.userId = body.userId;
    state.slug = body.slug;

    if (state.lastAlertAt && now - state.lastAlertAt < COOLDOWN_MS) {
      await this.saveState(state);
      return Response.json({ ok: true });
    }

    if (state.count >= COUNT_CAP) {
      await this.fireAlert(state);
      return Response.json({ ok: true });
    }

    await this.ctx.storage.setAlarm(now + DEBOUNCE_MS);
    await this.saveState(state);
    return Response.json({ ok: true });
  }

  async alarm(): Promise<void> {
    const state = await this.getState();

    if (state.lastAlertAt && Date.now() - state.lastAlertAt < COOLDOWN_MS) {
      this.resetWindow(state);
      await this.saveState(state);
      return;
    }

    await this.fireAlert(state);
  }

  private resetWindow(state: ErrorAlertState): void {
    state.count = 0;
    state.firstErrorAt = null;
    state.lastErrorAt = null;
  }

  private async fireAlert(state: ErrorAlertState): Promise<void> {
    if (!this.env.EMAIL) {
      this.resetWindow(state);
      await this.ctx.storage.deleteAlarm();
      await this.saveState(state);
      return;
    }

    try {
      const db = createDb(this.env.HYPERDRIVE.connectionString);
      const user = await getUser(db, state.userId);
      if (!user?.email) {
        // Decision: No email on record isn't transient, so don't retry.
        this.resetWindow(state);
        await this.ctx.storage.deleteAlarm();
        await this.saveState(state);
        return;
      }
      // Decision: Resolve the canonical slug from the DB: dispatch may have sent a hostname for custom-domain
      // traffic.
      const project = await getProject(db, state.projectId);
      const slug = project?.slug ?? state.slug;
      const errorWindow =
        state.firstErrorAt !== null && state.lastErrorAt !== null
          ? { start: state.firstErrorAt, end: state.lastErrorAt }
          : null;
      await sendErrorAlertEmail(this.env, user.email, slug, state.count, errorWindow);
      state.lastAlertAt = Date.now();
      this.resetWindow(state);
      await this.ctx.storage.deleteAlarm();
      await this.saveState(state);
    } catch (error) {
      console.error('[error-alert-monitor] failed to send alert:', error);
      await this.ctx.storage.setAlarm(Date.now() + DEBOUNCE_MS);
      await this.saveState(state);
    }
  }
}
