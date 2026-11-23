/** @jsxImportSource react */

import { Activity, CircleCheck, CircleHelp, CircleX, Clock } from 'lucide-react';
import { useSyncExternalStore, type ReactNode } from 'react';
import { AdminCard } from './AdminCard.tsx';

const clockListeners = new Set<() => void>();
let clockNow = Date.now();
let clockInterval: ReturnType<typeof setInterval> | undefined;

function subscribeToClock(listener: () => void) {
  if (clockListeners.size === 0) {
    clockNow = Date.now();
    clockInterval = setInterval(() => {
      clockNow = Date.now();
      for (const notify of clockListeners) {
        notify();
      }
    }, 5_000);
  }
  clockListeners.add(listener);
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0) {
      clearInterval(clockInterval);
    }
  };
}

function readClock() {
  return clockNow;
}

export function LastCheckedTime({
  checkedAt,
  unavailable,
}: {
  checkedAt?: number;
  unavailable: boolean;
}) {
  const now = useSyncExternalStore(subscribeToClock, readClock, readClock);
  const seconds = checkedAt === undefined ? 0 : Math.max(0, Math.floor((now - checkedAt) / 1000));
  const age =
    seconds < 5
      ? 'just now'
      : seconds < 60
        ? `${seconds}s ago`
        : `${Math.floor(seconds / 60)}m ago`;
  return (
    <span className="platform-admin-health-checked-at" data-unavailable={unavailable || undefined}>
      {unavailable ? (
        <span role="status">Status unavailable</span>
      ) : checkedAt !== undefined ? (
        <time
          dateTime={new Date(checkedAt).toISOString()}
          title={new Date(checkedAt).toLocaleTimeString()}
        >
          Checked {age}
        </time>
      ) : null}
    </span>
  );
}

export type StatusCardState = 'loading' | 'healthy' | 'error' | 'unavailable' | 'waiting';

export function StatusCard({
  id,
  title,
  state,
  statusLabel,
  headerAccessory,
  children,
}: {
  id?: string;
  title: string;
  state: StatusCardState;
  statusLabel: string;
  headerAccessory?: ReactNode;
  children: ReactNode;
}) {
  const Icon =
    state === 'healthy'
      ? CircleCheck
      : state === 'error'
        ? CircleX
        : state === 'waiting'
          ? Clock
          : state === 'loading'
            ? Activity
            : CircleHelp;
  return (
    <div id={id} className="platform-admin-status-card" data-state={state}>
      <AdminCard
        title={title}
        titleIcon={
          <span className="platform-admin-health-overall-icon" role="img" aria-label={statusLabel}>
            <Icon size={20} aria-hidden="true" />
          </span>
        }
        headerAccessory={headerAccessory}
      >
        {children}
      </AdminCard>
    </div>
  );
}
