// One EventSource per open run page. The snapshot seeds everything; events patch the live state
// through the pure reducer; React Query caches are invalidated on lifecycle edges so REST readers
// (library, spec inspector) stay fresh. Native EventSource retry + Last-Event-ID (log cursor)
// handle reconnects — a reconnect re-delivers a snapshot, so the client is never wrong.
import { useEffect, useReducer, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { RunEvent } from '../../../shared/api-types';
import { api } from './client';
import { initialRunLive, reduceRunEvents, type ClientRunEvent, type RunLive } from './run-events';

export function useRunEvents(runId: string | undefined): RunLive & { connected: boolean } {
  const qc = useQueryClient();
  const [state, dispatch] = useReducer((s: RunLive, e: ClientRunEvent) => reduceRunEvents(s, e), undefined, initialRunLive);
  const [connected, setConnected] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);

  // REST refetches (invalidated below on lifecycle edges) flow back into the live state — the
  // manifest (takes/revisions/cuts lineage) only updates on disk, so events alone would go stale.
  const runQ = useQuery({ queryKey: ['run', runId], queryFn: () => api.run(runId!), enabled: !!runId });
  const freshRun = runQ.data?.run;
  useEffect(() => {
    if (freshRun) dispatch({ type: 'run-refresh', run: freshRun });
  }, [freshRun]);

  useEffect(() => {
    if (!runId) return;
    dispatch({ type: 'run-reset' }); // runId changed in-place — never show run A's state under run B's URL
    // the ring buffer's history: without it a page opened mid-work shows an empty log until the
    // next line lands (minutes, on slow LLM steps) and the run reads as stuck
    let cancelled = false;
    api.log(runId, 0)
      .then((d) => { if (!cancelled && d.lines.length) dispatch({ type: 'log-backlog', lines: d.lines }); })
      .catch(() => { /* backlog is best-effort */ });
    const es = new EventSource(`/api/runs/${runId}/events`);
    sourceRef.current = es;
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (msg) => {
      let event: RunEvent;
      try { event = JSON.parse(msg.data); } catch { return; }
      dispatch(event);
      if (event.type === 'status' || event.type === 'done' || event.type === 'error') {
        qc.invalidateQueries({ queryKey: ['run', runId] });
        qc.invalidateQueries({ queryKey: ['runs'] });
      }
      if (event.type === 'spec-block') qc.invalidateQueries({ queryKey: ['spec', runId] });
    };
    return () => { cancelled = true; es.close(); sourceRef.current = null; setConnected(false); };
  }, [runId, qc]);

  return { ...state, connected };
}
