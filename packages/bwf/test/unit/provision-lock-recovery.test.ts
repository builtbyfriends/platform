import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import { acquireProvisionLock, resolveProperLockfileKey } from '../../src/cli/provision.ts';
import {
  passthruFs,
  reap,
  spawnHang,
  useProvisionTestDir,
  waitForDead,
} from './provision-fixtures.ts';

const { tmpDir, wranglerPath, setup } = useProvisionTestDir('lock-recovery');

describe('acquireProvisionLock — quarantine sidecar gate', () => {
  const sidecar = `${wranglerPath}.bwf-provision.lock.quarantine.json`;
  const lockMutex = `${wranglerPath}.bwf-provision.lock.lock`;

  it('a quarantined mutex is NOT stealable by age while the recorded group lives (fail closed, sidecar atomic)', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const child = spawnHang();
    try {
      const lock = await acquireProvisionLock(wranglerPath);
      lock.quarantine({ pid: child.pid, reason: 'test quarantine (child unconfirmed)' });
      const recorded = JSON.parse(readFileSync(sidecar, 'utf8')) as Record<string, unknown>;
      expect(recorded).toMatchObject({
        pid: child.pid,
        // Decision: Windows has no process groups, so `writeQuarantineSidecar` records `null` there by design
        // and the gate falls back to probing the plain pid.
        pgid: process.platform === 'win32' ? null : child.pid,
        reason: 'test quarantine (child unconfirmed)',
      });
      expect(typeof recorded.quarantinedAt).toBe('string');
      expect(readdirSync(tmpDir).filter((f) => f.includes('.tmp-'))).toEqual([]);
      expect(existsSync(lockMutex)).toBe(true);
      const old = new Date(Date.now() - 3_600_000);
      utimesSync(lockMutex, old, old);
      await expect(acquireProvisionLock(wranglerPath, { stale: 2000, retries: 0 })).rejects.toThrow(
        new RegExp(`QUARANTINED.*process group ${child.pid}.*test quarantine`, 's'),
      );
      expect(existsSync(sidecar)).toBe(true);
      expect(existsSync(lockMutex)).toBe(true);
    } finally {
      reap(child);
    }
    expect(await waitForDead(child.pid!, 10_000)).toBe(true);
  }, 15_000);

  it('once the recorded group is DEAD, the next acquisition clears the sidecar and proceeds', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const child = spawnHang();
    const lock = await acquireProvisionLock(wranglerPath);
    lock.quarantine({ pid: child.pid, reason: 'test quarantine' });
    reap(child);
    expect(await waitForDead(child.pid!, 10_000)).toBe(true);
    // Decision: Backdate the mutex so proper-lockfile's stale lifecycle reclaims it; the gate doesn't remove
    // it by hand.
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(lockMutex, old, old);
    const second = await acquireProvisionLock(wranglerPath, { stale: 2000, retries: 5 });
    expect(existsSync(sidecar)).toBe(false);
    await second.release();
    expect(existsSync(lockMutex)).toBe(false);
  }, 15_000);

  it('an unreadable/malformed sidecar FAILS CLOSED (cannot verify the recorded owner)', async () => {
    setup(JSON.stringify({ name: 'app' }));
    writeFileSync(sidecar, '{ not json');
    await expect(acquireProvisionLock(wranglerPath, { stale: 2000, retries: 0 })).rejects.toThrow(
      /QUARANTINED.*an unrecorded process/s,
    );
    expect(existsSync(sidecar)).toBe(true);
  });
});

describe('acquireProvisionLock — the gate runs on EVERY attempt + post-acquire revalidation', () => {
  const sidecar = `${wranglerPath}.bwf-provision.lock.quarantine.json`;
  const lockMutex = `${wranglerPath}.bwf-provision.lock.lock`;

  it('a waiter that started while the holder was HEALTHY fails closed when the holder quarantines mid-wait', async () => {
    // Decision: A gate run only before proper-lockfile's retry loop would let this waiter stale-take the
    // quarantined mutex without seeing the sidecar.
    setup(JSON.stringify({ name: 'app' }));
    const holder = await acquireProvisionLock(wranglerPath, { stale: 2000 });
    const child = spawnHang();
    try {
      const waiter = acquireProvisionLock(wranglerPath, {
        stale: 2000,
        retries: { retries: 60, factor: 1, minTimeout: 150, maxTimeout: 150 },
      });
      // Decision: Let the waiter run a few healthy attempts first, then quarantine the holder.
      await new Promise((r) => setTimeout(r, 400));
      holder.quarantine({ pid: child.pid, reason: 'waiter crosses quarantine' });
      await expect(waiter).rejects.toThrow(/QUARANTINED.*waiter crosses quarantine/s);
      expect(existsSync(sidecar)).toBe(true);
      expect(existsSync(lockMutex)).toBe(true);
    } finally {
      reap(child);
    }
    expect(await waitForDead(child.pid!, 5000)).toBe(true);
    rmSync(lockMutex, { recursive: true, force: true });
    rmSync(sidecar, { force: true });
  }, 15_000);

  it('the same waiter PROCEEDS (sidecar cleared) once the recorded group is dead', async () => {
    setup(JSON.stringify({ name: 'app' }));
    const holder = await acquireProvisionLock(wranglerPath, { stale: 2000 });
    const child = spawnHang();
    const waiter = acquireProvisionLock(wranglerPath, {
      stale: 2000,
      retries: { retries: 80, factor: 1, minTimeout: 150, maxTimeout: 150 },
    });
    await new Promise((r) => setTimeout(r, 300));
    // Decision: Kill the group before quarantining, so the waiter's next gate probes it dead.
    reap(child);
    expect(await waitForDead(child.pid!, 5000)).toBe(true);
    holder.quarantine({ pid: child.pid, reason: 'waiter proceeds once dead' });
    const lock = await waiter;
    expect(existsSync(sidecar)).toBe(false);
    await lock.release();
    expect(existsSync(lockMutex)).toBe(false);
  }, 15_000);

  it('post-acquire REVALIDATION: a sidecar appearing DURING acquisition releases the fresh lock and fails closed', async () => {
    // Decision: A holder quarantines between this attempt's gate and the mkdir that acquires the mutex.
    setup(JSON.stringify({ name: 'app' }));
    const child = spawnHang();
    try {
      const seamFs = {
        ...passthruFs,
        mkdir: (...args: Array<unknown>) => {
          writeFileSync(
            sidecar,
            JSON.stringify({
              pid: child.pid,
              pgid: child.pid,
              reason: 'appeared mid-acquisition',
            }),
          );
          (passthruFs.mkdir as (...a: Array<unknown>) => void)(...args);
        },
      };
      await expect(
        acquireProvisionLock(wranglerPath, { stale: 2000, retries: 0, fs: seamFs }),
      ).rejects.toThrow(/QUARANTINED.*appeared mid-acquisition/s);
      expect(existsSync(lockMutex)).toBe(false);
      expect(existsSync(sidecar)).toBe(true);
    } finally {
      reap(child);
    }
    expect(await waitForDead(child.pid!, 5000)).toBe(true);
    rmSync(sidecar, { force: true });
  });
});

describe('acquireProvisionLock — proper-lockfile registry key spelling', () => {
  it('preserves the native separators used by proper-lockfile on each platform', () => {
    const lockTarget = 'D:/a/platform/platform/wrangler.jsonc.platform-provision.lock';

    expect(resolveProperLockfileKey(lockTarget, 'win32')).toBe(
      String.raw`D:\a\platform\platform\wrangler.jsonc.platform-provision.lock`,
    );
    expect(
      resolveProperLockfileKey('/tmp/platform/wrangler.jsonc.platform-provision.lock', 'linux'),
    ).toBe('/tmp/platform/wrangler.jsonc.platform-provision.lock');
  });
});

describe('acquireProvisionLock — recovery decisions are serialized + generation-verified', () => {
  const sidecar = `${wranglerPath}.bwf-provision.lock.quarantine.json`;
  const lockMutex = `${wranglerPath}.bwf-provision.lock.lock`;
  const recoveryTarget = `${wranglerPath}.bwf-provision.lock.recovery`;

  async function deadPid(): Promise<number> {
    const child = spawnHang();
    const pid = child.pid!;
    reap(child);
    expect(await waitForDead(pid, 5000)).toBe(true);
    return pid;
  }

  it('a held RECOVERY mutex blocks another acquirer from acting on the sidecar at all (decision serialized)', async () => {
    // Decision: The whole gate, probe, clear, acquire and revalidate sequence runs under the recovery mutex,
    // so one recoverer can't act on a read another has invalidated.
    setup(JSON.stringify({ name: 'app' }));
    const pid = await deadPid();
    writeFileSync(
      sidecar,
      JSON.stringify({ pid, pgid: pid, reason: 'dead group', generation: 'gen-stale' }),
    );
    const properLockfile = (await import('proper-lockfile')).default;
    const releaseRecovery = await properLockfile.lock(recoveryTarget, {
      stale: 6000,
      realpath: false,
    });
    try {
      await expect(acquireProvisionLock(wranglerPath, { retries: 0 })).rejects.toThrow(
        /already being held/,
      );
      expect(existsSync(sidecar)).toBe(true);
    } finally {
      await releaseRecovery();
    }
    const lock = await acquireProvisionLock(wranglerPath, { retries: 2 });
    expect(existsSync(sidecar)).toBe(false);
    await lock.release();
    expect(existsSync(lockMutex)).toBe(false);
  });

  it("a stale recovery decision cannot delete a NEWER quarantine generation (B's decision detects S1; A's retained mutex stays protected)", async () => {
    // Decision: The recovery mutex can't serialize a main-mutex holder's quarantine write. B decides to clear
    // dead S0, then A's newer live-group S1 replaces the file before B's unlink.
    setup(JSON.stringify({ name: 'app' }));
    const dead = await deadPid();
    const live = spawnHang();
    try {
      writeFileSync(
        sidecar,
        JSON.stringify({
          pid: dead,
          pgid: dead,
          reason: 'S0 (dead group)',
          generation: 'gen-first',
        }),
      );
      // Decision: A's retained mutex, which B would stale-reclaim if it deleted S1.
      mkdirSync(lockMutex);
      const old = new Date(Date.now() - 3_600_000);
      utimesSync(lockMutex, old, old);
      const swapInNewerGeneration = (): void => {
        writeFileSync(
          sidecar,
          JSON.stringify({
            pid: live.pid,
            pgid: live.pid,
            reason: 'S1 (live group, newer quarantine)',
            generation: 'gen-second',
          }),
        );
      };
      await expect(
        acquireProvisionLock(wranglerPath, {
          stale: 2000,
          retries: 0,
          onBeforeQuarantineClear: swapInNewerGeneration,
        }),
      ).rejects.toThrow(/changed while this recovery decision was being made/);
      const recorded = JSON.parse(readFileSync(sidecar, 'utf8')) as Record<string, unknown>;
      expect(recorded.generation).toBe('gen-second');
      expect(recorded.pid).toBe(live.pid);
      expect(existsSync(lockMutex)).toBe(true);
      await expect(acquireProvisionLock(wranglerPath, { stale: 2000, retries: 0 })).rejects.toThrow(
        /QUARANTINED/,
      );
      expect(existsSync(lockMutex)).toBe(true);
    } finally {
      reap(live);
    }
    expect(await waitForDead(live.pid!, 5000)).toBe(true);
    rmSync(lockMutex, { recursive: true, force: true });
    rmSync(sidecar, { force: true });
  });
});
