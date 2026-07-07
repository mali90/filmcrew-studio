// Renders take minutes and users tab away: tab-title badge + OS notification on the transitions
// that matter (plan ready, render finished, failed). Baseline-seeded — never floods on load.
import { useEffect, useRef } from 'react';
import { useGlobalEvents } from './useGlobalEvents';

const NOTIFY_STATUSES: Record<string, string> = {
  'plan-ready': 'Plan ready — review it before rendering',
  review: 'Render finished — ready to review',
  attention: 'A run needs attention',
  complete: 'Final video is ready',
};

export function useNotifications() {
  const { lastRunStatus, active } = useGlobalEvents();
  const seen = useRef<string | null>(null);

  // tab title reflects activity
  useEffect(() => {
    const base = 'Filmcrew Studio';
    document.title = active.length ? `▶ working — ${base}` : base;
  }, [active.length]);

  useEffect(() => {
    if (!lastRunStatus) return;
    const key = `${lastRunStatus.runId}:${lastRunStatus.status}`;
    if (seen.current === key) return;
    seen.current = key;
    const message = NOTIFY_STATUSES[lastRunStatus.status];
    if (!message || document.visibilityState === 'visible') return; // only notify when tabbed away
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification('Filmcrew Studio', { body: message });
    }
  }, [lastRunStatus]);
}

/** Ask once, at the moment of the first paid action (the natural "I'll be waiting" moment). */
export function requestNotifyPermission() {
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}
