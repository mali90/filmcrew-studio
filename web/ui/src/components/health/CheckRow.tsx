// One health check as an ACTIONABLE row — icon + label + web-native hint, and exactly one fix
// affordance on the right: a quiet Fix button (hard rows), an install disclosure (ffmpeg/ffprobe),
// a deferral note (soft rows in the wizard, where Cast doesn't exist yet) or a real Cast link
// (settings). Shared by the wizard's health step and Settings > Health.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ChevronDown, XCircle } from 'lucide-react';
import clsx from 'clsx';
import type { DoctorReport } from '../../../../shared/api-types';
import { Button } from '../ui/Button';
import { FIX_TARGET, webHint } from './copy';
import { FfmpegPanel } from './FfmpegPanel';

type Check = DoctorReport['checks'][number];

export function CheckRow({ check, context, platform, refetching, failedRechecks, allChecks, onFix, onRecheck, onAnchor }: {
  check: Check;
  context: 'wizard' | 'settings';
  platform?: string;
  refetching: boolean;
  failedRechecks: number;
  allChecks: Check[];
  onFix?: (step: 'llm' | 'fal' | 'backend') => void;      // wizard: jump to the owning step
  onRecheck: () => void;
  onAnchor?: (headingId: string) => void;                  // settings: scroll+focus the owning card
}) {
  const wizard = context === 'wizard';
  const ffmpegAlsoFailing = allChecks.some((c) => c.id === 'ffmpeg' && !c.ok);
  const isBinary = check.id === 'ffmpeg' || check.id === 'ffprobe';
  // ffprobe ships with ffmpeg: when both fail, only the ffmpeg row carries the full panel
  const ownsPanel = isBinary && !check.ok && !(check.id === 'ffprobe' && ffmpegAlsoFailing);
  const [panelOpen, setPanelOpen] = useState(wizard && check.id === 'ffmpeg'); // the wizard auto-expands the only unfixable-in-web check
  const target = FIX_TARGET[check.id];
  const soft = check.soft;

  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-0.5 shrink-0" aria-hidden>
        {check.ok ? (
          <CheckCircle2 size={wizard ? 16 : 15} className="text-status-done transition-colors duration-[200ms]" />
        ) : soft ? (
          <AlertTriangle size={wizard ? 16 : 15} className="text-status-warn" />
        ) : (
          <XCircle size={wizard ? 16 : 15} className="text-status-failed" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className={clsx('block text-ink', wizard ? 'text-body' : 'text-dense')}>{check.label}</span>
        {!check.ok && (
          <span className={clsx('block text-caption', soft ? 'text-ink-muted' : 'text-status-failed')}>
            {webHint(check, context)}
          </span>
        )}
        {ownsPanel && panelOpen && (
          <FfmpegPanel
            binary={check.id as 'ffmpeg' | 'ffprobe'}
            platform={platform}
            refetching={refetching}
            failedRechecks={failedRechecks}
            onRecheck={onRecheck}
          />
        )}
      </span>
      <span className="-mt-1 ml-auto shrink-0">
        {!check.ok && ownsPanel && (
          <Button
            variant="quiet"
            size="sm"
            aria-expanded={panelOpen}
            icon={<ChevronDown size={12} className={clsx('transition-transform duration-[120ms]', panelOpen && 'rotate-180')} aria-hidden />}
            onClick={() => setPanelOpen((v) => !v)}
          >
            {wizard && check.id === 'ffmpeg' ? 'Show install steps' : 'How to install'}
          </Button>
        )}
        {!check.ok && !soft && !isBinary && target && (
          wizard
            ? <Button variant="quiet" size="sm" onClick={() => onFix?.(target.step)}>{target.wizardLabel}</Button>
            : <Button variant="quiet" size="sm" onClick={() => onAnchor?.(target.settingsAnchor)}>{target.settingsLabel}</Button>
        )}
        {!check.ok && soft && (
          wizard
            ? <span className="text-caption text-ink-faint">later, on the Cast page</span>
            : <Link to="/cast" className="text-caption text-accent transition-colors duration-[120ms] hover:text-accent-hover">Open Cast</Link>
        )}
      </span>
    </li>
  );
}
