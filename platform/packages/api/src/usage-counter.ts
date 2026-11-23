import { DurableObject } from 'cloudflare:workers';
import {
  createDb,
  getUser,
  getProjectOwnershipPeriodsByProjectIds,
  getProjectsByIds,
  suspendUser,
  unsuspendUserIfReason,
  type Db,
} from './db.ts';
import type { ApiEnv } from './env.ts';
import { resolvePlanLimits } from './plans.ts';
import { queryProjectAiUsage } from './routes/usage.ts';
import {
  sandboxBlockKey,
  setProjectAiBlock,
  setProjectsRoutingSuspension,
  verifyActiveProjectOwner,
} from './routing.ts';
import { REASON_REQUESTS_EXCEEDED, REASON_SANDBOX_RUNTIME_EXCEEDED } from './suspension.ts';
import {
  getCurrentBillingPeriodStart,
  getPlanLimits,
  isWithinLimit,
  type PlanLimits,
} from './tiers.ts';
import { SANDBOX_USAGE_RETENTION_MS } from './usage-auth.ts';

export type CounterState = {
  /** Account represented by this counter, learned from trusted API requests. */
  ownerUserId: string | null;
  totalRequests: number;
  totalNeurons: number;
  totalSandboxSeconds: number;
  plan: string;
  billingPeriodStart: string;
  billingPeriodInitialized?: boolean;
  requestsSuspended: boolean;
  aiSuspended: boolean;
  sandboxRuntimeSuspended: boolean;
  projectSlugs: Record<string, string>;
  /** Start of the current ownership period for each actively owned project. */
  projectOwnershipStarts: Record<string, string>;
  /** Latest per-project AI readings for actively owned projects. */
  projectNeurons: Record<string, number>;
  /** AI usage retained from projects transferred away during this billing period. */
  historicalNeurons: number;
  /** Closed ownership windows that remain re-queryable while Analytics ingestion settles. */
  historicalAiWindows: Record<
    string,
    {
      projectId: string;
      ownershipStartedAt: string;
      ownershipEndedAt: string;
      neurons: number;
    }
  >;
};

/** Cadence of the AI usage reconciliation alarm. */
const AI_ALARM_INTERVAL_MS = 15 * 60 * 1000;

const SANDBOX_WATERMARK_PREFIX = 'sandbox-usage:watermark:';
const SANDBOX_PRUNE_CURSOR_KEY = 'sandbox-usage:prune-cursor';
const SANDBOX_PRUNE_BATCH_SIZE = 64;

async function sandboxWatermarkKey(leaseId: string, from: number): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([leaseId, from])),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `${SANDBOX_WATERMARK_PREFIX}${hash}`;
}

export type UsageEvent = Readonly<{
  projectId: string;
  userId: string;
  slug: string;
  requests: number;
  responseBytes: number;
  status?: number;
  failureKind?:
    | 'platform-static-asset-timeout'
    | 'platform-static-asset-error'
    | 'platform-static-asset-missing';
  sandboxRuntimeSeconds?: number;
  sandboxInstanceId?: string;
  /** Cumulative server-owned lease generation; from stays fixed across heartbeats. */
  sandboxMeteredFrom?: number;
  sandboxMeteredThrough?: number;
  /** Set by the API consumer after resolving the event's ownership period. */
  currentOwner?: boolean;
  /** Current ownership-period boundary, when `currentOwner` is true. */
  ownershipStartedAt?: string;
}>;

/** Returns true if adding incomingRequests would exceed the plan's requestsPerMonth limit. */
export function evaluateRequestLimit(
  state: CounterState,
  incomingRequests: number,
  limits: PlanLimits = getPlanLimits(state.plan),
): boolean {
  return !isWithinLimit(limits.requestsPerMonth, state.totalRequests + incomingRequests);
}

/** Returns true if totalNeurons exceeds the plan's aiNeuronsPerMonth limit. Works for ALL plans. */
export function evaluateAiLimit(
  state: CounterState,
  limits: PlanLimits = getPlanLimits(state.plan),
): boolean {
  return !isWithinLimit(limits.aiNeuronsPerMonth, state.totalNeurons);
}

/** Returns true if adding incomingSeconds would exceed the plan's sandboxRuntimeSecondsPerMonth limit. */
export function evaluateSandboxRuntimeLimit(
  state: CounterState,
  incomingSeconds: number,
  limits: PlanLimits = getPlanLimits(state.plan),
): boolean {
  return !isWithinLimit(
    limits.sandboxRuntimeSecondsPerMonth,
    state.totalSandboxSeconds + incomingSeconds,
  );
}

function defaultState(): CounterState {
  return {
    ownerUserId: null,
    totalRequests: 0,
    totalNeurons: 0,
    totalSandboxSeconds: 0,
    plan: 'free',
    billingPeriodStart: new Date().toISOString(),
    billingPeriodInitialized: false,
    requestsSuspended: false,
    aiSuspended: false,
    sandboxRuntimeSuspended: false,
    projectSlugs: {},
    projectOwnershipStarts: {},
    projectNeurons: {},
    historicalNeurons: 0,
    historicalAiWindows: {},
  };
}

async function settleWrites(writes: Array<Promise<unknown>>): Promise<void> {
  // Decision: A rejected write mustn't release the operation queue while a sibling write can still land and
  // undo the next operation's suspension decision, so wait for all of them.
  const results = await Promise.allSettled(writes);
  for (const result of results) {
    if (result.status === 'rejected') {
      throw result.reason;
    }
  }
}

export class UsageCounter extends DurableObject<ApiEnv['Bindings']> {
  private state: CounterState | null = null;
  private operationTail: Promise<void> = Promise.resolve();

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    // Decision: External suspension writes and AI queries open the DO input gate. Keep each request and alarm in
    // order through its durable save, including retries.
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async getState(): Promise<CounterState> {
    if (!this.state) {
      const stored = await this.ctx.storage.get<CounterState>('state');
      // Decision: Backfill defaults so DOs with pre-sandbox state load cleanly.
      this.state = stored
        ? {
            ...defaultState(),
            ...stored,
            billingPeriodInitialized: stored.billingPeriodInitialized ?? true,
          }
        : defaultState();
    }
    // Decision: Each operation edits its own copy, so a failed external write or storage put can't silently
    // commit totals or latches to the cache.
    return {
      ...this.state,
      projectSlugs: { ...this.state.projectSlugs },
      projectOwnershipStarts: { ...this.state.projectOwnershipStarts },
      projectNeurons: { ...this.state.projectNeurons },
      historicalAiWindows: structuredClone(this.state.historicalAiWindows),
    };
  }

  private async saveState(
    state: CounterState,
    options: {
      watermarks?: ReadonlyMap<string, number>;
      scheduleAiAlarm?: boolean;
    } = {},
  ): Promise<boolean> {
    const cutoff = Date.now() - SANDBOX_USAGE_RETENTION_MS;
    const hasWatermarks = await this.ctx.storage.transaction(async (transaction) => {
      // Decision: Receipts live in separate bounded-size records. Don't evict a fresh generation to make room: its
      // next cumulative frame would bill it again.
      for (const [key, through] of options.watermarks ?? []) {
        await transaction.put(key, through);
      }

      // Decision: Advance a durable cursor by at most one page per operation. Hash order isn't age order, so wrap
      // after the last page and revisit each receipt over time without scanning the full set.
      const cursor = await transaction.get<string>(SANDBOX_PRUNE_CURSOR_KEY);
      const page = await transaction.list<number>({
        prefix: SANDBOX_WATERMARK_PREFIX,
        ...(cursor ? { startAfter: cursor } : {}),
        limit: SANDBOX_PRUNE_BATCH_SIZE,
      });
      const expired = Array.from(page, ([key, through]) => (through < cutoff ? key : null)).filter(
        (key) => key !== null,
      );
      if (expired.length > 0) {
        await transaction.delete(expired);
      }
      if (page.size === SANDBOX_PRUNE_BATCH_SIZE) {
        await transaction.put(SANDBOX_PRUNE_CURSOR_KEY, Array.from(page.keys()).at(-1)!);
      } else {
        await transaction.delete(SANDBOX_PRUNE_CURSOR_KEY);
      }

      // Decision: Counters, receipts and pruning progress commit together. Publishing the isolate cache after that
      // keeps a rejected commit retryable.
      await transaction.put('state', state);
      if (options.scheduleAiAlarm) {
        const nextAlarm = Date.now() + AI_ALARM_INTERVAL_MS;
        const alarm = await transaction.getAlarm();
        if (alarm === null || alarm > nextAlarm) {
          await transaction.setAlarm(nextAlarm);
        }
      }
      return page.size > expired.length || page.size === SANDBOX_PRUNE_BATCH_SIZE || !!cursor;
    });
    this.state = state;
    return hasWatermarks;
  }

  async fetch(request: Request): Promise<Response> {
    return this.serialize(() => this.handleFetch(request));
  }

  private async handleFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'POST' && path === '/record') {
      return this.handleRecord(request);
    }
    if (request.method === 'POST' && path === '/rollover') {
      return this.handleRollover(request);
    }
    if (request.method === 'POST' && path === '/init') {
      return this.handleInit(request);
    }
    if (request.method === 'POST' && path === '/attach-project') {
      return this.handleAttachProject(request);
    }
    if (request.method === 'POST' && path === '/detach-project') {
      return this.handleDetachProject(request);
    }
    if (request.method === 'POST' && path === '/reevaluate-limits') {
      return this.handleReevaluateLimits(request);
    }
    if (request.method === 'POST' && path === '/clear-suspension') {
      return this.handleClearSuspension();
    }
    if (request.method === 'GET' && path === '/state') {
      return this.handleGetState();
    }

    return new Response('not found', { status: 404 });
  }

  private async handleRecord(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      events: ReadonlyArray<UsageEvent>;
      plan?: string;
      userId: string;
      billingPeriodStart?: string;
    };
    const state = await this.getState();
    if (body.userId) {
      state.ownerUserId = body.userId;
    }
    // Decision: A new counter can first see an interval after it ended. Its construction time isn't the
    // account's billing-period boundary.
    if (!state.billingPeriodInitialized && body.billingPeriodStart) {
      if (!Number.isFinite(Date.parse(body.billingPeriodStart))) {
        return Response.json({ error: 'invalid billing period' }, { status: 400 });
      }
      state.billingPeriodStart = body.billingPeriodStart;
      state.billingPeriodInitialized = true;
    }

    const incomingRequests = body.events.reduce((sum, e) => sum + e.requests, 0);
    state.totalRequests += incomingRequests;

    // Decision: The API-owned producer sends cumulative intervals with a stable start per lease generation. A high
    // watermark handles retries and out-of-order delivery; a new generation leaves out idle time between
    // leases.
    const periodStart = state.billingPeriodInitialized ? Date.parse(state.billingPeriodStart) : 0;
    const watermarkCutoff = Date.now() - SANDBOX_USAGE_RETENTION_MS;
    const watermarks = new Map<string, number>();
    let incomingSandboxSeconds = 0;
    for (const event of body.events) {
      const leaseId = event.sandboxInstanceId;
      const from = event.sandboxMeteredFrom;
      const through = event.sandboxMeteredThrough;
      if (
        !leaseId ||
        !Number.isSafeInteger(from) ||
        !Number.isSafeInteger(through) ||
        through! <= from! ||
        through! < watermarkCutoff
      ) {
        continue;
      }
      const key = await sandboxWatermarkKey(leaseId, from!);
      const previous = watermarks.get(key) ?? (await this.ctx.storage.get<number>(key)) ?? from!;
      const billFrom = Math.max(
        previous,
        from!,
        Number.isFinite(periodStart) ? periodStart : from!,
        // Decision: Receipts older than retention may already be pruned. A cumulative frame mustn't revive their
        // billed prefix after a long delivery gap.
        watermarkCutoff,
      );
      if (through! > billFrom) {
        incomingSandboxSeconds += (through! - billFrom) / 1000;
      }
      watermarks.set(key, Math.max(previous, through!));
    }
    state.totalSandboxSeconds += incomingSandboxSeconds;

    // Decision: Only the current owner may keep a project in the active enforcement set. Recheck the queue
    // consumer's snapshot here so a transfer that finished before this serialized operation can't be
    // undone by a delayed record.
    let db: ReturnType<typeof createDb> | undefined;
    const getDb = (): ReturnType<typeof createDb> => {
      db ??= createDb(this.env.HYPERDRIVE.connectionString);
      return db;
    };
    const attachmentCandidates = [
      ...new Set(
        body.events
          .filter(
            (event) =>
              event.currentOwner !== false && !Object.hasOwn(state.projectSlugs, event.projectId),
          )
          .map((event) => event.projectId),
      ),
    ];
    const approvedAttachments =
      attachmentCandidates.length > 0
        ? await this.ownedProjectIds(getDb(), attachmentCandidates, body.userId)
        : new Set<string>();
    for (const event of body.events) {
      if (
        event.currentOwner !== false &&
        (Object.hasOwn(state.projectSlugs, event.projectId) ||
          approvedAttachments.has(event.projectId))
      ) {
        state.projectSlugs[event.projectId] = event.slug;
        if (event.ownershipStartedAt) {
          state.projectOwnershipStarts[event.projectId] = event.ownershipStartedAt;
        }
      }
    }

    // Decision: The queue envelope may have waited behind a plan change, so resolve ownership and limits from
    // PostgreSQL, not the producer hint.
    const owner = await getUser(getDb(), body.userId);
    state.plan = owner?.plan ?? state.plan;
    const limits = await resolvePlanLimits(getDb(), state.plan);

    // Decision: Commit each suspension latch only after each enforcement write succeeds.
    const exceedsLimit = evaluateRequestLimit(state, 0, limits);
    if (exceedsLimit && !state.requestsSuspended) {
      await settleWrites([
        this.suspendProjects(getDb(), state.projectSlugs, body.userId, REASON_REQUESTS_EXCEEDED),
        suspendUser(getDb(), body.userId, REASON_REQUESTS_EXCEEDED),
      ]);
      // Decision: The first route stamp and the account-row update run together on purpose. An ownership-transfer
      // republish can land between them after reading the old account row, so reconcile once more after
      // both settle.
      await this.suspendProjects(
        getDb(),
        state.projectSlugs,
        body.userId,
        REASON_REQUESTS_EXCEEDED,
      );
      state.requestsSuspended = true;
    }

    const exceedsSandbox = evaluateSandboxRuntimeLimit(state, 0, limits);
    if (exceedsSandbox && !state.sandboxRuntimeSuspended) {
      await settleWrites([
        this.env.ROUTING.put(sandboxBlockKey(body.userId), '1'),
        suspendUser(getDb(), body.userId, REASON_SANDBOX_RUNTIME_EXCEEDED),
      ]);
      state.sandboxRuntimeSuspended = true;
    }

    await this.ensureAiAlarm();

    await this.saveState(state, { watermarks });

    return Response.json({
      totalRequests: state.totalRequests,
      suspended: state.requestsSuspended,
      totalSandboxSeconds: state.totalSandboxSeconds,
      sandboxRuntimeSuspended: state.sandboxRuntimeSuspended,
    });
  }

  private async handleRollover(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      billingPeriodStart: string;
      plan: string;
      userId: string;
    };
    const incomingPeriodStart = Date.parse(body.billingPeriodStart);
    if (!Number.isFinite(incomingPeriodStart)) {
      return Response.json({ error: 'invalid billing period' }, { status: 400 });
    }
    const state = await this.getState();
    if (body.userId) {
      state.ownerUserId = body.userId;
    }

    // Decision: A delayed scheduler snapshot mustn't rewind a ledger that already advanced.
    if (
      state.billingPeriodInitialized &&
      incomingPeriodStart <= Date.parse(state.billingPeriodStart)
    ) {
      return Response.json({
        rolled: false,
        unsuspendRequests: false,
        unsuspendAi: false,
        // Decision: Return the authoritative request-suspension latch on each response, not only on rollovers, so the
        // scheduler can reconcile the KV `suspended` marker against it each pass (see processUserRollover in
        // index.ts).
        requestsSuspended: state.requestsSuspended,
        projectSlugs: state.projectSlugs,
      });
    }

    const previousSuspensions = await this.advanceBillingPeriod(state, body, false);

    await this.saveState(state);

    return Response.json({
      rolled: true,
      unsuspendRequests: previousSuspensions.requests,
      unsuspendAi: previousSuspensions.ai,
      // Decision: Post-rollover latch, returned on each response so the scheduler reconciles KV against it each pass
      // (see processUserRollover in index.ts).
      requestsSuspended: state.requestsSuspended,
      projectSlugs: state.projectSlugs,
    });
  }

  private async handleInit(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      plan: string;
      billingPeriodStart: string;
      projectSlugs: Record<string, string>;
      projectOwnershipStarts?: Record<string, string>;
      userId?: string;
    };
    const incomingPeriodStart = Date.parse(body.billingPeriodStart);
    if (!Number.isFinite(incomingPeriodStart)) {
      return Response.json({ error: 'invalid billing period' }, { status: 400 });
    }
    const state = await this.getState();
    if (body.userId) {
      state.ownerUserId = body.userId;
    }

    // Decision: PostgreSQL owns the current project set. Replace instead of merging, so after an ownership
    // transfer the old owner's DO can't restamp the transferred project's routing or AI block.
    const previousProjectIds = new Set(Object.keys(state.projectSlugs));
    const removedProjectIds = [...previousProjectIds].filter(
      (projectId) => !(projectId in body.projectSlugs),
    );
    const db = createDb(this.env.HYPERDRIVE.connectionString);
    await this.syncBillingPeriod(state, body.billingPeriodStart, body.plan);
    await this.retainTransferredProjectWindows(db, state, removedProjectIds);
    state.projectSlugs = { ...body.projectSlugs };
    state.projectOwnershipStarts = Object.fromEntries(
      Object.keys(body.projectSlugs).flatMap((projectId) => {
        const startsAt =
          body.projectOwnershipStarts?.[projectId] ?? state.projectOwnershipStarts[projectId];
        return startsAt ? [[projectId, startsAt]] : [];
      }),
    );
    state.plan = body.plan;

    if (state.requestsSuspended) {
      await this.suspendProjects(
        db,
        state.projectSlugs,
        state.ownerUserId,
        REASON_REQUESTS_EXCEEDED,
      );
    }
    if (state.ownerUserId) {
      for (const projectId of Object.keys(state.projectSlugs)) {
        await setProjectAiBlock(
          this.env.ROUTING,
          db,
          projectId,
          state.ownerUserId,
          state.aiSuspended,
        );
      }
    }

    await this.saveState(state);
    if (Object.keys(state.historicalAiWindows).length > 0) {
      await this.ensureAiAlarm();
    }
    return Response.json({ ok: true });
  }

  private async handleAttachProject(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      projectId: string;
      slug: string;
      ownershipStartedAt: string;
      billingPeriodStart?: string;
      userId?: string;
    };
    if (
      !body.projectId ||
      !body.slug ||
      !body.ownershipStartedAt ||
      !Number.isFinite(Date.parse(body.ownershipStartedAt)) ||
      (body.billingPeriodStart !== undefined &&
        !Number.isFinite(Date.parse(body.billingPeriodStart)))
    ) {
      return Response.json({ error: 'invalid project attachment' }, { status: 400 });
    }
    const state = await this.getState();
    if (body.userId) {
      state.ownerUserId = body.userId;
    }
    const db = createDb(this.env.HYPERDRIVE.connectionString);
    if (
      !state.ownerUserId ||
      !(await verifyActiveProjectOwner(db, body.projectId, state.ownerUserId))
    ) {
      return Response.json({ error: 'project owner changed' }, { status: 409 });
    }
    const owner = state.ownerUserId ? await getUser(db, state.ownerUserId) : null;
    if (!owner) {
      return Response.json({ error: 'project owner changed' }, { status: 409 });
    }
    // Decision: A transfer request may have waited behind a concurrent plan change. PostgreSQL is authoritative;
    // don't restore the caller's stale pre-transfer snapshot.
    state.plan = owner.plan;
    if (body.billingPeriodStart !== undefined) {
      await this.syncBillingPeriod(state, body.billingPeriodStart, owner.plan);
    }
    if (
      !(await setProjectAiBlock(
        this.env.ROUTING,
        db,
        body.projectId,
        state.ownerUserId,
        state.aiSuspended,
      ))
    ) {
      return Response.json({ error: 'project owner changed' }, { status: 409 });
    }
    state.projectSlugs[body.projectId] = body.slug;
    state.projectOwnershipStarts[body.projectId] = body.ownershipStartedAt;
    if (state.requestsSuspended) {
      await this.suspendProjects(
        db,
        { [body.projectId]: body.slug },
        state.ownerUserId,
        REASON_REQUESTS_EXCEEDED,
      );
    }
    await this.saveState(state);
    await this.ensureAiAlarm();
    return Response.json({ ok: true });
  }

  private async handleDetachProject(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      projectId: string;
      userId?: string;
      billingPeriodStart?: string;
      ownershipStartedAt?: string;
      ownershipEndedAt?: string;
    };
    if (!body.projectId) {
      return Response.json({ error: 'projectId is required' }, { status: 400 });
    }
    if (
      (body.billingPeriodStart && !Number.isFinite(Date.parse(body.billingPeriodStart))) ||
      (body.ownershipStartedAt && !Number.isFinite(Date.parse(body.ownershipStartedAt))) ||
      (body.ownershipEndedAt && !Number.isFinite(Date.parse(body.ownershipEndedAt)))
    ) {
      return Response.json({ error: 'invalid ownership window' }, { status: 400 });
    }
    const state = await this.getState();
    if (body.userId) {
      state.ownerUserId = body.userId;
    }
    const db = createDb(this.env.HYPERDRIVE.connectionString);
    const owner = state.ownerUserId ? await getUser(db, state.ownerUserId) : null;
    if (owner) {
      state.plan = owner.plan;
    }
    if (body.billingPeriodStart) {
      await this.syncBillingPeriod(state, body.billingPeriodStart, state.plan);
    }
    if (body.ownershipEndedAt) {
      this.retainHistoricalAiWindow(
        state,
        body.projectId,
        body.ownershipStartedAt ?? state.projectOwnershipStarts[body.projectId],
        body.ownershipEndedAt,
      );
    } else {
      this.retainHistoricalAiSample(state, body.projectId);
    }
    this.recomputeTotalNeurons(state);
    // Decision: Teardown may remove the SQL ownership history once this returns. Keep the cutoff and its next
    // reconciliation in one durable transaction; provider analytics availability mustn't hold deletion
    // or transfer open.
    await this.saveState(state, {
      scheduleAiAlarm: Object.keys(state.historicalAiWindows).length > 0,
    });
    return Response.json({ ok: true });
  }

  /** Reconcile changed plan limits without resetting the billing ledger. */
  private async handleReevaluateLimits(request: Request): Promise<Response> {
    const body = (await request.json()) as { userId?: string };
    const state = await this.getState();
    const userId = body.userId ?? state.ownerUserId;
    if (!userId || (state.ownerUserId && state.ownerUserId !== userId)) {
      return Response.json({ error: 'counter owner does not match' }, { status: 409 });
    }
    const db = createDb(this.env.HYPERDRIVE.connectionString);
    const owner = await getUser(db, userId);
    if (!owner) {
      return Response.json({ error: 'user not found' }, { status: 404 });
    }
    state.ownerUserId = userId;
    state.plan = owner.plan;
    const limits = await resolvePlanLimits(db, owner.plan);
    const requestsSuspended = evaluateRequestLimit(state, 0, limits);
    const sandboxRuntimeSuspended = evaluateSandboxRuntimeLimit(state, 0, limits);
    const aiSuspended = evaluateAiLimit(state, limits);
    const ownedProjects = await this.ownedProjects(db, state.projectSlugs, userId);

    await settleWrites([
      (async () => {
        if (requestsSuspended || sandboxRuntimeSuspended) {
          await suspendUser(
            db,
            userId,
            requestsSuspended ? REASON_REQUESTS_EXCEEDED : REASON_SANDBOX_RUNTIME_EXCEEDED,
          );
        } else {
          await unsuspendUserIfReason(db, userId, REASON_REQUESTS_EXCEEDED);
          await unsuspendUserIfReason(db, userId, REASON_SANDBOX_RUNTIME_EXCEEDED);
        }
      })(),
      setProjectsRoutingSuspension(
        this.env.ROUTING,
        db,
        ownedProjects,
        requestsSuspended
          ? { op: 'suspend', reason: REASON_REQUESTS_EXCEEDED, force: false }
          : { op: 'unsuspend', matchReason: REASON_REQUESTS_EXCEEDED },
      ),
      sandboxRuntimeSuspended
        ? this.env.ROUTING.put(sandboxBlockKey(userId), '1')
        : this.env.ROUTING.delete(sandboxBlockKey(userId)),
      ...ownedProjects.map((project) =>
        setProjectAiBlock(this.env.ROUTING, db, project.id, userId, aiSuspended),
      ),
    ]);
    state.requestsSuspended = requestsSuspended;
    state.sandboxRuntimeSuspended = sandboxRuntimeSuspended;
    state.aiSuspended = aiSuspended;
    await this.saveState(state);
    await this.ensureAiAlarm();
    return Response.json({ ok: true, requestsSuspended, sandboxRuntimeSuspended, aiSuspended });
  }

  /**
   * Admin unsuspend: drop the request + sandbox suspension latches. The admin
   * route clears the corresponding KV routes concurrently with this call and the
   * DB reason only after this succeeds; resetting the latches here stops the next
   * billing-reconcile `/init` from re-stamping the routes (the `requestsSuspended`
   * branch) and lets the next `/record` re-evaluate against current usage. AI
   * self-heals via the alarm, so `aiSuspended` is intentionally left untouched.
   * This is a latch reset only — no counters change (unlike a billing rollover).
   * Shares the operation queue so an in-flight record cannot restore the latch.
   */
  private async handleClearSuspension(): Promise<Response> {
    const state = await this.getState();
    state.requestsSuspended = false;
    state.sandboxRuntimeSuspended = false;
    await this.saveState(state);
    return Response.json({ ok: true });
  }

  private async handleGetState(): Promise<Response> {
    const state = await this.getState();
    return Response.json(state);
  }

  async alarm(): Promise<void> {
    return this.serialize(async () => {
      try {
        await this.handleAlarm();
      } catch (error) {
        // Decision: Native alarm retries are bounded. Set a future wakeup to survive longer provider outages without
        // replacing stored usage with zero.
        await this.ctx.storage.setAlarm(Date.now() + AI_ALARM_INTERVAL_MS);
        throw error;
      }
    });
  }

  private async handleAlarm(): Promise<void> {
    const state = await this.getState();

    // Decision: Older stored states don't name their account. Wait for the next trusted record, rollover or init
    // instead of risking a cross-owner KV write.
    if (!state.ownerUserId) {
      await this.saveState(state);
      await this.ctx.storage.setAlarm(Date.now() + AI_ALARM_INTERVAL_MS);
      return;
    }

    const db = createDb(this.env.HYPERDRIVE.connectionString);
    const ownedProjectIds = await this.ownedProjectIds(
      db,
      Object.keys(state.projectSlugs),
      state.ownerUserId,
    );
    const transferredProjectIds = Object.keys(state.projectSlugs).filter(
      (projectId) => !ownedProjectIds.has(projectId),
    );
    await this.retainTransferredProjectWindows(db, state, transferredProjectIds);
    if (Object.keys(state.historicalAiWindows).length > 0) {
      // Decision: Deleting the last project also deletes its ownership history, so the scheduler can't find this
      // counter for billing rollover any more.
      const owner = await getUser(db, state.ownerUserId);
      if (!owner) {
        await this.ctx.storage.deleteAlarm();
        return;
      }
      state.plan = owner.plan;
      if (owner.billing_cycle_start) {
        const billingPeriodStart = getCurrentBillingPeriodStart(owner.billing_cycle_start);
        if (billingPeriodStart.getTime() > Date.parse(state.billingPeriodStart)) {
          await this.advanceBillingPeriod(
            state,
            {
              billingPeriodStart: billingPeriodStart.toISOString(),
              plan: owner.plan,
              userId: owner.id,
            },
            true,
          );
        }
      }
    }
    const currentOwner = await getUser(db, state.ownerUserId);
    if (currentOwner) {
      state.plan = currentOwner.plan;
    }
    const limits = await resolvePlanLimits(db, state.plan);
    const projectIds = [...ownedProjectIds];
    // Decision: Closed windows still need reconciliation on unlimited plans: detachment keeps their samples
    // without depending on the provider. Otherwise inactive accounts wake only while receipt pruning has
    // work.
    if (
      Object.keys(state.historicalAiWindows).length === 0 &&
      (limits.aiNeuronsPerMonth === 0 || projectIds.length === 0)
    ) {
      if (await this.saveState(state)) {
        await this.ctx.storage.setAlarm(Date.now() + AI_ALARM_INTERVAL_MS);
      }
      return;
    }

    // Decision: Re-query closed ownership windows because Analytics ingestion can lag the transfer transaction.
    // Exact half-open cutoffs keep either owner from being charged for the other side of the transfer.
    await this.refreshHistoricalAiWindows(state);

    const billingSince = new Date(state.billingPeriodStart);
    for (const projectId of limits.aiNeuronsPerMonth === 0 ? [] : projectIds) {
      const ownershipStartedAt = state.projectOwnershipStarts[projectId];
      const ownershipSince = ownershipStartedAt ? new Date(ownershipStartedAt) : billingSince;
      const since =
        Number.isFinite(ownershipSince.getTime()) && ownershipSince > billingSince
          ? ownershipSince
          : billingSince;
      const result = await queryProjectAiUsage(
        this.env.CF_ACCOUNT_ID,
        this.env.CF_API_TOKEN,
        this.env.AI_GATEWAY_ID ?? 'platform',
        this.env.JWT_SECRET,
        projectId,
        since,
      );
      state.projectNeurons[projectId] = result.neurons;
    }

    this.recomputeTotalNeurons(state);

    const exceedsAi = evaluateAiLimit(state, limits);
    if (exceedsAi && !state.aiSuspended) {
      state.aiSuspended = true;
      for (const projectId of projectIds) {
        await setProjectAiBlock(this.env.ROUTING, db, projectId, state.ownerUserId, true);
      }
    } else if (!exceedsAi && state.aiSuspended) {
      state.aiSuspended = false;
      for (const projectId of projectIds) {
        await setProjectAiBlock(this.env.ROUTING, db, projectId, state.ownerUserId, false);
      }
    }

    await this.saveState(state);

    await this.ctx.storage.setAlarm(Date.now() + AI_ALARM_INTERVAL_MS);
  }

  private async ensureAiAlarm(): Promise<void> {
    if (!(await this.ctx.storage.getAlarm())) {
      await this.ctx.storage.setAlarm(Date.now() + AI_ALARM_INTERVAL_MS);
    }
  }

  private retainHistoricalAiSample(state: CounterState, projectId: string): void {
    const billed = state.projectNeurons[projectId];
    if (typeof billed === 'number' && Number.isFinite(billed)) {
      state.historicalNeurons += billed;
    }
    delete state.projectNeurons[projectId];
    delete state.projectOwnershipStarts[projectId];
    delete state.projectSlugs[projectId];
  }

  private retainHistoricalAiWindow(
    state: CounterState,
    projectId: string,
    ownershipStartedAt: string | undefined,
    ownershipEndedAt: string,
  ): string | null {
    const billingStartedAt = new Date(state.billingPeriodStart);
    const startedAt = new Date(ownershipStartedAt ?? state.billingPeriodStart);
    const endedAt = new Date(ownershipEndedAt);
    if (
      !Number.isFinite(billingStartedAt.getTime()) ||
      !Number.isFinite(startedAt.getTime()) ||
      !Number.isFinite(endedAt.getTime()) ||
      endedAt <= startedAt
    ) {
      this.retainHistoricalAiSample(state, projectId);
      return null;
    }
    const normalizedStart = startedAt.toISOString();
    const matchingWindows = Object.entries(state.historicalAiWindows).filter(
      ([, window]) =>
        window.projectId === projectId &&
        Date.parse(window.ownershipStartedAt) === startedAt.getTime(),
    );
    const effectiveEnd = Math.max(
      endedAt.getTime(),
      ...matchingWindows
        .map(([, window]) => Date.parse(window.ownershipEndedAt))
        .filter(Number.isFinite),
    );
    const normalizedEnd = new Date(effectiveEnd).toISOString();
    const key = JSON.stringify([projectId, normalizedStart, normalizedEnd]);
    const existing = state.historicalAiWindows[key] ?? matchingWindows[0]?.[1];
    const sampled = state.projectNeurons[projectId];
    for (const [matchingKey] of matchingWindows) {
      delete state.historicalAiWindows[matchingKey];
    }
    state.historicalAiWindows[key] = {
      projectId,
      ownershipStartedAt: normalizedStart,
      ownershipEndedAt: normalizedEnd,
      neurons:
        existing?.neurons ??
        (typeof sampled === 'number' && Number.isFinite(sampled) ? sampled : 0),
    };
    delete state.projectNeurons[projectId];
    delete state.projectOwnershipStarts[projectId];
    delete state.projectSlugs[projectId];
    return key;
  }

  private async retainTransferredProjectWindows(
    db: Db,
    state: CounterState,
    projectIds: ReadonlyArray<string>,
  ): Promise<void> {
    if (projectIds.length === 0) {
      return;
    }
    const periods = await getProjectOwnershipPeriodsByProjectIds(db, projectIds);
    for (const projectId of projectIds) {
      const expectedStart = state.projectOwnershipStarts[projectId];
      const candidates = periods
        .filter(
          (period) =>
            period.project_id === projectId &&
            period.owner_user_id === state.ownerUserId &&
            period.ends_at !== null,
        )
        .sort((left, right) => Date.parse(right.ends_at!) - Date.parse(left.ends_at!));
      const period =
        candidates.find(
          (candidate) =>
            expectedStart && Date.parse(candidate.starts_at) === Date.parse(expectedStart),
        ) ?? candidates[0];
      if (period?.ends_at) {
        this.retainHistoricalAiWindow(state, projectId, period.starts_at, period.ends_at);
      } else {
        // Decision: Project deletion removes ownership history with the project. Keep the last sampled amount when no
        // closed transfer window survives.
        this.retainHistoricalAiSample(state, projectId);
      }
    }
  }

  private async refreshHistoricalAiWindows(state: CounterState): Promise<void> {
    const billingSince = new Date(state.billingPeriodStart);
    for (const key of Object.keys(state.historicalAiWindows)) {
      const window = state.historicalAiWindows[key];
      if (!window) {
        continue;
      }
      const ownershipSince = new Date(window.ownershipStartedAt);
      const until = new Date(window.ownershipEndedAt);
      const since = ownershipSince > billingSince ? ownershipSince : billingSince;
      if (until <= since) {
        window.neurons = 0;
        continue;
      }
      const result = await queryProjectAiUsage(
        this.env.CF_ACCOUNT_ID,
        this.env.CF_API_TOKEN,
        this.env.AI_GATEWAY_ID ?? 'platform',
        this.env.JWT_SECRET,
        window.projectId,
        since,
        until,
        true,
      );
      window.neurons = result.neurons;
    }
  }

  private recomputeTotalNeurons(state: CounterState): void {
    const current = Object.values(state.projectNeurons).reduce(
      (total, neurons) => total + neurons,
      0,
    );
    const historicalWindows = Object.values(state.historicalAiWindows).reduce(
      (total, window) => total + window.neurons,
      0,
    );
    state.totalNeurons = state.historicalNeurons + historicalWindows + current;
  }

  /**
   * Adopt the caller's billing period on an uninitialized counter, or advance the
   * ledger when the period moved forward. Plan reconciliation can precede the
   * hourly rollover; never label old totals as new usage.
   */
  private async syncBillingPeriod(
    state: CounterState,
    billingPeriodStart: string,
    plan: string,
  ): Promise<void> {
    const incomingPeriodStart = Date.parse(billingPeriodStart);
    const currentPeriodStart = Date.parse(state.billingPeriodStart);
    if (!state.billingPeriodInitialized) {
      state.billingPeriodStart = billingPeriodStart;
      state.billingPeriodInitialized = true;
    } else if (!Number.isFinite(currentPeriodStart) || incomingPeriodStart > currentPeriodStart) {
      await this.advanceBillingPeriod(
        state,
        { billingPeriodStart, plan, userId: state.ownerUserId ?? '' },
        true,
      );
    }
  }

  private async advanceBillingPeriod(
    state: CounterState,
    next: { billingPeriodStart: string; plan: string; userId: string },
    reconcileRequestSuspension: boolean,
  ): Promise<Readonly<{ requests: boolean; ai: boolean }>> {
    const requests = state.requestsSuspended;
    const ai = state.aiSuspended;
    const sandbox = state.sandboxRuntimeSuspended;
    const db = createDb(this.env.HYPERDRIVE.connectionString);

    // Decision: Finish idempotent external cleanup before committing the new period. A failure leaves the cached
    // and stored period unchanged for retry.
    if (ai) {
      const ownerUserId = next.userId || state.ownerUserId;
      if (ownerUserId) {
        for (const projectId of Object.keys(state.projectSlugs)) {
          await setProjectAiBlock(this.env.ROUTING, db, projectId, ownerUserId, false);
        }
      }
    }
    if (sandbox) {
      await settleWrites([
        this.env.ROUTING.delete(sandboxBlockKey(next.userId)),
        unsuspendUserIfReason(db, next.userId, REASON_SANDBOX_RUNTIME_EXCEEDED),
      ]);
    }
    if (requests && reconcileRequestSuspension) {
      const ownerUserId = next.userId || state.ownerUserId;
      if (!ownerUserId) {
        throw new Error('cannot reconcile request suspension without an owner');
      }
      const ownedProjects = await this.ownedProjects(db, state.projectSlugs, ownerUserId);
      await settleWrites([
        unsuspendUserIfReason(db, ownerUserId, REASON_REQUESTS_EXCEEDED),
        setProjectsRoutingSuspension(this.env.ROUTING, db, ownedProjects, {
          op: 'unsuspend',
          matchReason: REASON_REQUESTS_EXCEEDED,
        }),
      ]);
    }

    state.totalRequests = 0;
    state.totalNeurons = 0;
    state.totalSandboxSeconds = 0;
    state.historicalNeurons = 0;
    state.historicalAiWindows = {};
    state.projectNeurons = {};
    state.plan = next.plan;
    state.billingPeriodStart = next.billingPeriodStart;
    state.billingPeriodInitialized = true;
    state.requestsSuspended = false;
    state.aiSuspended = false;
    state.sandboxRuntimeSuspended = false;

    return { requests, ai };
  }

  private async suspendProjects(
    db: Db,
    projectSlugs: Record<string, string>,
    expectedOwnerUserId: string | null,
    reason: string,
  ): Promise<void> {
    if (!expectedOwnerUserId) {
      return;
    }
    // Decision: Stamp `suspended` on each project's slug route and its active custom-domain routes: dispatch
    // enforces suspension from all of them.
    // `force: false`: a usage suspension mustn't overwrite an admin suspension on the route. Downgrading
    // `admin_suspended` to `requests_exceeded` would let a later usage unsuspend lift an admin action.
    const projects = await this.ownedProjects(db, projectSlugs, expectedOwnerUserId);
    await setProjectsRoutingSuspension(this.env.ROUTING, db, projects, {
      op: 'suspend',
      reason,
      force: false,
    });
  }

  /** Routing targets for the tracked projects `ownerUserId` still owns. */
  private async ownedProjects(
    db: Db,
    projectSlugs: Record<string, string>,
    ownerUserId: string,
  ): Promise<Array<{ id: string; slug: string; user_id: string }>> {
    const ownedIds = await this.ownedProjectIds(db, Object.keys(projectSlugs), ownerUserId);
    return Object.entries(projectSlugs).flatMap(([id, slug]) =>
      ownedIds.has(id) ? [{ id, slug, user_id: ownerUserId }] : [],
    );
  }

  /** Prevent a stale former-owner counter from mutating transferred projects. */
  private async ownedProjectIds(
    db: Db,
    projectIds: ReadonlyArray<string>,
    expectedOwnerUserId: string | null,
  ): Promise<Set<string>> {
    if (!expectedOwnerUserId || projectIds.length === 0) {
      return new Set();
    }
    const projects = await getProjectsByIds(db, projectIds);
    return new Set(
      projects
        .filter(
          (project) => project.user_id === expectedOwnerUserId && project.status !== 'deleting',
        )
        .map((project) => project.id),
    );
  }
}
