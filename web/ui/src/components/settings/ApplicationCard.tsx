// Application — restart or shut down the local server from the UI. Confirms are state-aware
// (a render in flight means committed fal spend whose result may never land), the shutdown ends
// in an honest farewell state that self-heals if the server returns, and the restart overlay only
// reloads when it sees a NEW bootId (the dying process answers health checks for a beat).
import { useEffect, useRef, useState } from 'react';
import { Power, RotateCw } from 'lucide-react';
import { api } from '../../api/client';
import { useGlobalEvents } from '../../hooks/useGlobalEvents';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Spinner } from '../ui/Spinner';
import { useToast } from '../ui/Toast';

type Phase = 'idle' | 'confirm-restart' | 'confirm-quit' | 'restarting' | 'off';

function useHealthPoll(active: boolean, intervalMs: number, onAlive: (bootId: string) => void) {
  const cb = useRef(onAlive);
  cb.current = onAlive;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      api.health().then((h) => cb.current(h.bootId)).catch(() => { /* still down — keep trying */ });
    }, intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs]);
}

export function ApplicationCard() {
  const { toast } = useToast();
  const { active } = useGlobalEvents();
  const rendering = active.some((j) => j.lane === 'spend');

  const [phase, setPhase] = useState<Phase>('idle');
  const [slow, setSlow] = useState(false);
  const bootIdRef = useRef<string | null>(null);

  const restart = async () => {
    try {
      bootIdRef.current = await api.health().then((h) => h.bootId).catch(() => null);
      await api.restartApp();
      setPhase('restarting');
      setSlow(false);
      setTimeout(() => setSlow(true), 20_000);
    } catch {
      toast({ kind: 'error', text: 'The restart could not start — check the server terminal.' });
      setPhase('idle');
    }
  };
  const quit = async () => {
    try {
      await api.quitApp();
      setPhase('off');
    } catch {
      toast({ kind: 'error', text: 'The shutdown could not start — check the server terminal.' });
      setPhase('idle');
    }
  };

  // restart: reload only on a DIFFERENT bootId; off: any answer means the server came back
  useHealthPoll(phase === 'restarting', 750, (bootId) => {
    if (bootId && bootId !== bootIdRef.current) window.location.reload();
  });
  useHealthPoll(phase === 'off', 3000, () => window.location.reload());

  if (phase === 'off') {
    return (
      <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-3 bg-surface-0 px-6 text-center">
        <Power size={20} className="text-ink-muted" aria-hidden />
        <h1 className="text-display text-ink">The studio is off.</h1>
        <p className="max-w-[420px] text-body text-ink-secondary">
          You shut down the server from here. To come back, run <span className="font-mono">npm run web</span> in
          the project folder.
        </p>
        <p className="text-caption text-ink-faint">This page will reconnect on its own if the server comes back.</p>
      </div>
    );
  }

  return (
    <section aria-labelledby="application-heading" className="rounded-r3 border border-line bg-surface-1 p-5">
      <h2 id="application-heading" className="text-heading text-ink">Application</h2>
      <p className="mt-1 text-dense text-ink-muted">This studio runs as a local server on your machine.</p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={<RotateCw size={14} aria-hidden />}
          onClick={() => (rendering ? setPhase('confirm-restart') : void restart())}
        >
          Restart
        </Button>
        <Button variant="destructive" size="sm" icon={<Power size={14} aria-hidden />} onClick={() => setPhase('confirm-quit')}>
          Shut down
        </Button>
      </div>
      <p className="mt-2 text-caption text-ink-muted">
        Restart picks up .env and code changes — the page reconnects on its own. Shut down stops the
        server; start it again with <span className="font-mono">npm run web</span>.
      </p>

      <Dialog
        open={phase === 'confirm-restart'}
        onClose={() => setPhase('idle')}
        title="Restart during a render?"
        actions={
          <>
            <Button variant="secondary" onClick={() => setPhase('idle')}>Keep rendering</Button>
            <Button variant="destructive" onClick={() => void restart()}>Restart anyway</Button>
          </>
        }
      >
        A render is still in flight. Restarting drops the studio&rsquo;s watch on it — the fal.ai charge
        stands, but the shot may be lost and come back failed.
      </Dialog>

      <Dialog
        open={phase === 'confirm-quit'}
        onClose={() => setPhase('idle')}
        title={rendering ? 'Shut down during a render?' : 'Shut down the studio?'}
        actions={
          <>
            <Button variant={rendering ? 'secondary' : 'ghost'} onClick={() => setPhase('idle')}>
              {rendering ? 'Keep rendering' : 'Cancel'}
            </Button>
            <Button variant="destructive" onClick={() => void quit()}>
              {rendering ? 'Shut down anyway' : 'Shut down'}
            </Button>
          </>
        }
      >
        {rendering
          ? 'A render is still in flight. If you shut down, the studio stops watching it — the charge at fal.ai stands, but the finished video may never land in your run.'
          : <>The server stops and this page goes dark. Start it again anytime with <span className="font-mono">npm run web</span>.</>}
      </Dialog>

      {phase === 'restarting' && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-surface-0/70 backdrop-blur-sm">
          <div className="flex max-w-[420px] flex-col items-center gap-3 rounded-r3 border border-line bg-surface-1 p-6 text-center" style={{ boxShadow: 'var(--shadow-2)' }}>
            <Spinner size={18} />
            <h2 className="text-heading text-ink">Restarting the studio…</h2>
            <p className="text-caption text-ink-muted">Back in a few seconds — this page will reconnect on its own.</p>
            {slow && (
              <p role="alert" className="text-caption text-status-failed">
                Still nothing after 20 seconds. Check the terminal that runs the server — it may not have
                come back. This page keeps trying.
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
