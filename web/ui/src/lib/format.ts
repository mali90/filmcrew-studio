// Small shared formatters — every number the UI shows goes through these (tnum class handles the
// typography; these handle the words).
export const usd = (n: number | null | undefined) =>
  n == null ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const seconds = (s: number | null | undefined) => (s == null ? 'auto' : `${s}s`);

export const elapsed = (ms: number | null | undefined) => {
  if (ms == null) return '';
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m ? `${m}:${String(s).padStart(2, '0')}` : `0:${String(s).padStart(2, '0')}`;
};

export const bytes = (n: number | null | undefined) => {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
};

export const timeAgo = (iso: string | null | undefined, now = Date.now()) => {
  if (!iso) return '';
  const diff = Math.max(0, now - new Date(iso).getTime());
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d ago` : new Date(iso).toLocaleDateString();
};

export const statusLabel: Record<string, string> = {
  planning: 'Planning',
  'plan-ready': 'Plan ready',
  rendering: 'Rendering',
  attention: 'Needs attention',
  review: 'Needs review',
  complete: 'Complete',
};
