// One global EventSource — SHARED by every subscriber (header pill, Home queue strip,
// notifications). Browsers cap concurrent HTTP/1.1 connections per origin (~6); one stream per
// hook call would spend three of them per tab before a run page even opens its own stream.
// The stream is refcounted: first subscriber opens it, last one closes it. Falls back gracefully —
// if the stream drops, React Query's normal fetching still works.
import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { GlobalEvent, QueueItem } from '../../../shared/api-types';

export interface GlobalLive {
  active: QueueItem[];
  queued: QueueItem[];
  lastRunStatus: { runId: string; status: string } | null;
}

const EMPTY: GlobalLive = { active: [], queued: [], lastRunStatus: null };

let stream: EventSource | null = null;
let refs = 0;
let state: GlobalLive = EMPTY;
const storeListeners = new Set<() => void>();
const eventListeners = new Set<(e: GlobalEvent) => void>();

function fold(event: GlobalEvent) {
  if (event.type === 'snapshot') state = { ...state, ...event.queue };
  else if (event.type === 'queue') state = { ...state, active: event.active, queued: event.queued };
  else if (event.type === 'run-status') state = { ...state, lastRunStatus: { runId: event.runId, status: event.status } };
  else return;
  for (const l of storeListeners) l();
}

function retain() {
  refs += 1;
  if (stream) return;
  stream = new EventSource('/api/events');
  stream.onmessage = (msg) => {
    let event: GlobalEvent;
    try { event = JSON.parse(msg.data); } catch { return; }
    fold(event);
    for (const l of eventListeners) l(event);
  };
}

function release() {
  refs -= 1;
  if (refs > 0) return;
  stream?.close();
  stream = null;
  state = EMPTY;
}

const subscribe = (l: () => void) => { storeListeners.add(l); return () => storeListeners.delete(l); };
const getSnapshot = () => state;

export function useGlobalEvents(): GlobalLive {
  const qc = useQueryClient();
  useEffect(() => {
    retain();
    const onEvent = (e: GlobalEvent) => {
      if (e.type === 'run-status') qc.invalidateQueries({ queryKey: ['runs'] });
    };
    eventListeners.add(onEvent);
    return () => { eventListeners.delete(onEvent); release(); };
  }, [qc]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
