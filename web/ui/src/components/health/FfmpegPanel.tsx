// The guided ffmpeg/ffprobe install panel — the one health check the app cannot fix by itself.
// Inline (never a modal: the user copies a command, leaves for a terminal, comes back and
// re-checks — the checklist must stay under their feet). OS-aware via the SERVER's platform.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { api, ApiClientError } from '../../api/client';
import { Button } from '../ui/Button';
import { CommandBlock } from '../ui/CommandBlock';
import { useToast } from '../ui/Toast';
import { OS_COMMANDS, osCommandFor, type OsCommand } from './copy';

function OsCommandBlock({ os }: { os: OsCommand }) {
  return (
    <div>
      <CommandBlock label={os.label} command={os.command} how={os.how} />
      {os.id === 'darwin' && (
        <p className="mt-1 text-caption text-ink-muted">
          No Homebrew? It&rsquo;s the standard Mac package manager — get its one-line installer at{' '}
          <a href="https://brew.sh" target="_blank" rel="noreferrer" className="text-accent hover:text-accent-hover">brew.sh</a>,
          run that first, then the command above.
        </p>
      )}
    </div>
  );
}

export function FfmpegPanel({ binary, platform, refetching, failedRechecks, onRecheck }: {
  binary: 'ffmpeg' | 'ffprobe';
  platform?: string;
  refetching: boolean;
  failedRechecks: number;
  onRecheck: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const detected = osCommandFor(platform);
  const [otherOpen, setOtherOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [binPath, setBinPath] = useState('');
  const envKey = binary === 'ffmpeg' ? 'FFMPEG_BIN' : 'FFPROBE_BIN';

  const savePath = useMutation({
    mutationFn: () => api.envWrite({ [envKey]: binPath.trim() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['doctor'] });
      qc.invalidateQueries({ queryKey: ['setup-doctor'] });
      qc.invalidateQueries({ queryKey: ['settings-env'] });
      onRecheck();
    },
    onError: (e) => toast({ kind: 'error', text: e instanceof ApiClientError ? `${e.message} — ${e.hint}` : 'Could not save the path.' }),
  });

  const showAdvanced = advancedOpen || failedRechecks >= 2;

  return (
    <div className="mt-2 rounded-r2 border border-line p-3">
      <p className="text-label font-medium text-ink">Install ffmpeg — a one-time step.</p>
      <p className="mt-1 text-caption text-ink-secondary">
        ffmpeg is a free system program, like the browser you&rsquo;re reading this in. It&rsquo;s the one
        piece this app can&rsquo;t install for you — but it&rsquo;s one command, and you&rsquo;ll never think
        about it again. Copy the command for your system, run it, then check again here.
      </p>

      <div className="mt-3">
        <OsCommandBlock os={detected} />
      </div>

      <button
        type="button"
        aria-expanded={otherOpen}
        onClick={() => setOtherOpen((v) => !v)}
        className="mt-2 flex items-center gap-1 text-caption text-ink-muted transition-colors duration-[120ms] hover:text-ink-secondary"
      >
        {otherOpen ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
        Not your system?
      </button>
      {otherOpen && (
        <div className="mt-2 space-y-3">
          {OS_COMMANDS.filter((o) => o.id !== detected.id).map((o) => <OsCommandBlock key={o.id} os={o} />)}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2.5">
        <Button variant="secondary" size="sm" loading={refetching} onClick={onRecheck}>Check again</Button>
        <span className="text-caption text-ink-muted">Re-runs every check.</span>
      </div>
      {failedRechecks > 0 && (
        <p className="mt-2 text-caption text-ink-muted">
          Still not found. Fresh installs are sometimes invisible to an app that&rsquo;s already running —
          restart it (Ctrl+C in its terminal, then <span className="font-mono">npm run web</span>) — or
          point directly at the program below.
        </p>
      )}

      <button
        type="button"
        aria-expanded={showAdvanced}
        onClick={() => setAdvancedOpen((v) => !v)}
        className="mt-2 flex items-center gap-1 text-caption text-ink-muted transition-colors duration-[120ms] hover:text-ink-secondary"
      >
        {showAdvanced ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
        Installed somewhere unusual?
      </button>
      {showAdvanced && (
        <div className="mt-2">
          <label htmlFor={`${binary}-path`} className="mb-1 block text-label text-ink-secondary">Path to {binary}</label>
          <div className="flex items-center gap-2">
            <input
              id={`${binary}-path`}
              value={binPath}
              onChange={(e) => setBinPath(e.target.value)}
              placeholder={`/opt/homebrew/bin/${binary}`}
              className="h-8 w-full rounded-r2 border border-line-strong bg-surface-2 px-2.5 font-mono text-dense text-ink outline-none placeholder:text-ink-faint focus:border-accent"
            />
            <Button variant="quiet" loading={savePath.isPending} disabled={!binPath.trim()} onClick={() => savePath.mutate()}>
              Save &amp; check
            </Button>
          </div>
          <p className="mt-1 text-caption text-ink-muted">Saved to .env as {envKey} — the checks re-run on save.</p>
        </div>
      )}
    </div>
  );
}
