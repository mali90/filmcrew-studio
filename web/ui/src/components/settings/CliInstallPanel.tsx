// The CLI-transport surface for one provider: detect whether its CLI is installed, offer a one-click
// install (streaming npm output), then guide the interactive login. Mirrors the ffmpeg guided-install
// panel's DNA but with a real install action. Rendered by KeysCard (and the wizard's StepLlm) in place
// of the API-key field when transport === 'cli'.
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Download, RotateCw, XCircle } from 'lucide-react';
import clsx from 'clsx';
import { api, ApiClientError } from '../../api/client';
import type { InstallCliEvent } from '../../../../shared/api-types';
import { Button } from '../ui/Button';
import { CommandBlock } from '../ui/CommandBlock';
import { Spinner } from '../ui/Spinner';
import { useToast } from '../ui/Toast';

// the installer colors its output — the browser shows words, not escape codes (from LogViewer)
const stripAnsi = (line: string) => line.replace(/\[[0-9;]*m|\[\d+m/g, '');
const lineClass = (line: string) => (/ERR|failed/i.test(line) ? 'text-status-failed' : /WRN|warn/i.test(line) ? 'text-status-warn' : 'text-ink-secondary');
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

// Friendly name + the login command per provider (codex logs in via `codex login`; the others open a
// browser/device sign-in when you just run the bare binary once).
const CLI_META: Record<string, { name: string; loginCmd: (bin: string) => string }> = {
  claude: { name: 'Claude CLI', loginCmd: (b) => b },
  openai: { name: 'Codex CLI', loginCmd: () => 'codex login' },
  gemini: { name: 'Gemini CLI', loginCmd: (b) => b },
  copilot: { name: 'Copilot CLI', loginCmd: (b) => b },
};

type Login = { state: 'idle' } | { state: 'checking' } | { state: 'valid' } | { state: 'invalid'; reason: string };
type LogLine = { stream: 'stdout' | 'stderr'; line: string };

export function CliInstallPanel({ provider, model, className }: { provider: string; model?: string; className?: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const status = useQuery({ queryKey: ['cli-status', provider], queryFn: () => api.cliStatus(provider) });

  const [log, setLog] = useState<LogLine[]>([]);
  const [installError, setInstallError] = useState<{ message: string; hint: string } | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [login, setLogin] = useState<Login>({ state: 'idle' });
  const [elapsed, setElapsed] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);

  // provider changed → forget everything from the previous provider
  useEffect(() => {
    setLog([]); setInstallError(null); setLogOpen(false); setManualOpen(false); setLogin({ state: 'idle' }); setElapsed(0);
  }, [provider]);

  const bin = status.data?.bin ?? provider;
  const npmPackage = status.data?.npmPackage ?? '';
  const meta = CLI_META[provider] ?? { name: `${bin} CLI`, loginCmd: (b: string) => b };
  const installCmd = `npm install -g ${npmPackage}`;
  const loginCmd = meta.loginCmd(bin);

  const testLogin = async () => {
    setLogin({ state: 'checking' });
    try {
      const r = await api.validateLlm({ provider, transport: 'cli', model: model || undefined });
      setLogin(r.ok ? { state: 'valid' } : { state: 'invalid', reason: r.reason ?? 'not signed in yet' });
    } catch (e) {
      setLogin({ state: 'invalid', reason: e instanceof ApiClientError ? e.hint : 'connection test failed' });
    }
  };

  const install = useMutation({
    mutationFn: () => {
      setLog([]); setInstallError(null); setLogOpen(false); setElapsed(0);
      return api.installCli(provider, (e: InstallCliEvent) => {
        if (e.type === 'log') setLog((prev) => [...prev, { stream: e.stream, line: e.line }]);
      });
    },
    onSuccess: (terminal) => {
      if (terminal.type === 'error') {
        setInstallError({ message: terminal.message, hint: terminal.hint });
        setLogOpen(true);
        return;
      }
      toast({ kind: 'success', text: `${meta.name} installed.` });
      qc.invalidateQueries({ queryKey: ['cli-status'] });   // this provider + the badges' bulk query
      qc.invalidateQueries({ queryKey: ['doctor'] });
      qc.invalidateQueries({ queryKey: ['setup-status'] });
      void testLogin();                                       // it's installed — check the login right away
    },
    onError: (e) => setInstallError({
      message: e instanceof ApiClientError ? e.message : 'Install failed',
      hint: e instanceof ApiClientError ? e.hint : 'Try again, or run the command yourself.',
    }),
  });

  // tick the elapsed timer + follow the log tail while installing
  useEffect(() => {
    if (!install.isPending) return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [install.isPending]);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log.length]);

  const recheck = () => { setLogin({ state: 'idle' }); void status.refetch(); };

  // ── derive the display state ──
  const installed = status.data?.installed;
  let state: 'checking' | 'error' | 'not-installed' | 'installing' | 'install-failed' | 'ready' | 'not-logged-in' | 'installed-idle';
  if (install.isPending) state = 'installing';
  else if (installError) state = 'install-failed';
  else if (status.isLoading) state = 'checking';
  else if (status.isError) state = 'error';
  else if (!installed) state = 'not-installed';
  else if (login.state === 'valid') state = 'ready';
  else if (login.state === 'invalid') state = 'not-logged-in';
  else state = 'installed-idle';

  const logWell = (
    <div ref={logRef} role="log" aria-label="Install log"
      className="well mt-2 max-h-40 overflow-y-auto rounded-r2 bg-stage p-3 font-mono text-caption">
      {log.length === 0
        ? <p className="text-ink-faint">Starting the installer…</p>
        : log.map((l, i) => <p key={i} className={clsx('whitespace-pre-wrap', lineClass(l.line))}>{stripAnsi(l.line)}</p>)}
    </div>
  );

  const icon = {
    checking: <Spinner size={14} />,
    error: <XCircle size={15} className="text-status-failed" />,
    'not-installed': <Download size={15} className="text-ink-muted" />,
    installing: <Spinner size={14} />,
    'install-failed': <XCircle size={15} className="text-status-failed" />,
    ready: <CheckCircle2 size={15} className="text-status-done" />,
    'not-logged-in': <AlertTriangle size={15} className="text-status-warn" />,
    'installed-idle': login.state === 'checking' ? <Spinner size={14} /> : <CheckCircle2 size={15} className="text-status-done" />,
  }[state];

  const title = {
    checking: `Checking for the ${meta.name}…`,
    error: `Couldn't check for the ${meta.name}`,
    'not-installed': `${meta.name} not installed`,
    installing: `Installing the ${meta.name}…`,
    'install-failed': `Couldn't install the ${meta.name}`,
    ready: `${meta.name} ready`,
    'not-logged-in': `${meta.name} installed — not signed in`,
    'installed-idle': `${meta.name} installed`,
  }[state];

  const srSummary = {
    checking: `Checking for the ${meta.name}.`,
    error: `Couldn't check for the ${meta.name}.`,
    'not-installed': `${meta.name} is not installed.`,
    installing: `Installing the ${meta.name}.`,
    'install-failed': `Install failed — ${installError?.message ?? ''}`,
    ready: `${meta.name} ready — installed and signed in.`,
    'not-logged-in': `${meta.name} installed but not signed in.`,
    'installed-idle': `${meta.name} installed — test the connection.`,
  }[state];

  return (
    <div className={clsx('mt-3', className)} data-cli-status={state}>
      <label className="mb-1 block text-label text-ink-secondary">Provider CLI</label>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0" aria-hidden>{icon}</span>
        <div className="min-w-0 flex-1">
          <p className="text-dense text-ink" aria-live="polite">
            {title}
            {state === 'ready' && (
              <span className="text-ink-faint"> · installed and signed in{status.data?.version ? ` · ${status.data.version}` : ''}</span>
            )}
          </p>

          {state === 'error' && <p className="mt-1 text-caption text-status-failed">Couldn&rsquo;t reach the server. <button type="button" className="text-accent hover:text-accent-hover" onClick={recheck}>Re-check</button></p>}

          {state === 'installed-idle' && (
            <div className="mt-2 flex items-center gap-2.5">
              <Button variant="secondary" size="sm" loading={login.state === 'checking'} onClick={() => void testLogin()}>Test connection</Button>
              <span className="text-caption text-ink-muted">Sign in with <span className="select-all font-mono">{loginCmd}</span> if the test fails.</span>
            </div>
          )}

          {state === 'ready' && (
            <div className="mt-2"><Button variant="quiet" size="sm" loading={login.state === 'checking'} onClick={() => void testLogin()}>Re-test</Button></div>
          )}

          {state === 'not-logged-in' && (
            <div className="mt-2 rounded-r2 border border-line p-3">
              <p className="text-label font-medium text-ink">Sign in to the {meta.name}</p>
              <p className="mt-1 text-caption text-status-failed">{login.state === 'invalid' ? login.reason : ''}</p>
              <p className="mt-1 text-caption text-ink-secondary">Run this once and complete sign-in, then test again. We can&rsquo;t sign in for you — it opens a browser/device login in your terminal.</p>
              <div className="mt-2"><CommandBlock command={loginCmd} how="Run it in a terminal, complete sign-in, then Test connection." /></div>
              <Button variant="secondary" size="sm" className="mt-2" loading={login.state === 'checking'} onClick={() => void testLogin()}>Test connection</Button>
            </div>
          )}

          {state === 'not-installed' && (
            <div className="mt-2 rounded-r2 border border-line p-3">
              <p className="text-label font-medium text-ink">Install the {meta.name}</p>
              <p className="mt-1 text-caption text-ink-secondary">
                CLI transport plans through the {meta.name} you&rsquo;re signed into — it isn&rsquo;t installed yet. Install it here: a one-time global npm install that takes 30&nbsp;seconds to a couple of minutes.
              </p>
              <div className="mt-3 flex items-center gap-2.5">
                <Button variant="secondary" size="sm" icon={<Download size={14} aria-hidden />} onClick={() => install.mutate()}>Install {meta.name}</Button>
                <span className="select-all font-mono text-caption text-ink-muted">{installCmd}</span>
              </div>
              <button type="button" aria-expanded={manualOpen} onClick={() => setManualOpen((v) => !v)}
                className="mt-2 flex items-center gap-1 text-caption text-ink-muted hover:text-ink-secondary">
                {manualOpen ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />} Prefer to run it yourself?
              </button>
              {manualOpen && (
                <div className="mt-2">
                  <CommandBlock command={installCmd} how="Run it in a terminal, then Re-check." />
                  <Button variant="secondary" size="sm" className="mt-2" loading={status.isFetching} onClick={recheck}>Re-check</Button>
                </div>
              )}
            </div>
          )}

          {state === 'installing' && (
            <div className="mt-2 rounded-r2 border border-line p-3">
              <div className="flex items-center gap-2">
                <Spinner size={12} />
                <span className="text-label font-medium text-ink">Installing the {meta.name}…</span>
                <span className="tnum ml-auto text-caption text-ink-muted">{mmss(elapsed)}</span>
              </div>
              {logWell}
              <p className="mt-2 text-caption text-ink-muted">First install can take a couple of minutes — you can keep using the rest of Settings.</p>
            </div>
          )}

          {state === 'install-failed' && (
            <div className="mt-2 rounded-r2 border border-line p-3">
              <p className="text-label font-medium text-ink">Install didn&rsquo;t finish</p>
              <p className="mt-1 text-caption text-status-failed">{installError?.hint ?? installError?.message}</p>
              <div className="mt-3 flex items-center gap-2.5">
                <Button variant="secondary" size="sm" icon={<RotateCw size={14} aria-hidden />} onClick={() => install.mutate()}>Retry install</Button>
                <button type="button" aria-expanded={logOpen} onClick={() => setLogOpen((v) => !v)}
                  className="flex items-center gap-1 text-caption text-ink-muted hover:text-ink-secondary">
                  {logOpen ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />} {logOpen ? 'Hide' : 'Show'} install log
                </button>
              </div>
              {logOpen && logWell}
              <p className="mt-2 text-caption text-ink-muted">Still failing? It&rsquo;s usually a permissions issue — install it yourself with the command below, then Re-check.</p>
              <div className="mt-2"><CommandBlock command={installCmd} how="Run it in a terminal, then Re-check." /></div>
            </div>
          )}
        </div>
      </div>
      <p role="status" className="sr-only">{srSummary}</p>
    </div>
  );
}
