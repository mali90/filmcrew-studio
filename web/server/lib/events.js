// Tiny per-run pub/sub — the fan-out point between the job manager / artifact watcher (producers)
// and SSE connections (consumers). Subscribing to '*' receives every run's events (the global
// stream and the notification hook use this).
export function createEventBus() {
  const subs = new Map(); // channel → Set<fn>
  return {
    subscribe(channel, fn) {
      if (!subs.has(channel)) subs.set(channel, new Set());
      subs.get(channel).add(fn);
      return () => subs.get(channel)?.delete(fn);
    },
    emit(channel, event) {
      for (const fn of subs.get(channel) ?? []) fn(event, channel);
      if (channel !== '*') for (const fn of subs.get('*') ?? []) fn(event, channel);
    },
  };
}

export default { createEventBus };
