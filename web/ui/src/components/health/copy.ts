// Web-native voice for the health checks. preflight.js's hints are written for a terminal
// ("put it in .env", "npm run mint-voice") — meaningless words inside an app that HAS a key
// form, a Cast page and an env editor. The web surfaces map each check's stable id to copy and
// a fix action; the CLI keeps its own dialect untouched.
import type { CheckId, DoctorReport } from '../../../../shared/api-types';

type Check = DoctorReport['checks'][number];

/** The hint shown under a FAILED row, in the app's own vocabulary. */
export function webHint(c: Check, context: 'wizard' | 'settings'): string {
  switch (c.id) {
    case 'fal-key': return 'The render key is missing or invalid.';
    case 'llm':
      if (/CLI/i.test(c.label)) return 'The planner CLI didn’t respond — it may not be installed or logged in.';
      if (/valid/.test(c.label)) return 'That planner isn’t one this app knows.';
      return 'No working key saved for the planner.';
    case 'backend': return 'That render backend isn’t one this app knows.';
    case 'ffmpeg': return 'Not found on this machine. It assembles your clips into the finished video.';
    case 'ffprobe': return 'Ships with ffmpeg — the install above covers it.';
    case 'references':
      return context === 'wizard'
        ? 'Optional — you’ll add reference images on the Cast page once you’re in.'
        : 'Optional — add reference images in Cast.';
    case 'voices':
      return context === 'wizard'
        ? 'Optional — you’ll mint character voices on the Cast page once you’re in.'
        : 'Optional — mint a voice per character in Cast.';
    case 'voice-clips':
      return 'Seedance lip-syncs to the original clip — re-mint the listed voices to restore theirs.';
    default: return c.hint;
  }
}

/** Which wizard step (or settings card) owns the fix for a hard check. */
export const FIX_TARGET: Partial<Record<CheckId, { step: 'llm' | 'fal' | 'backend'; wizardLabel: string; settingsLabel: string; settingsAnchor: string }>> = {
  'fal-key': { step: 'fal', wizardLabel: 'Fix key', settingsLabel: 'Fix in Keys', settingsAnchor: 'keys-heading' },
  llm: { step: 'llm', wizardLabel: 'Fix planner', settingsLabel: 'Fix in Keys', settingsAnchor: 'keys-heading' },
  backend: { step: 'backend', wizardLabel: 'Choose backend', settingsLabel: 'Fix in Defaults', settingsAnchor: 'defaults-heading' },
};

export interface OsCommand { id: string; label: string; command: string; how: string }

export const OS_COMMANDS: OsCommand[] = [
  {
    id: 'darwin',
    label: 'macOS — via Homebrew',
    command: 'brew install ffmpeg',
    how: 'Open Terminal (press ⌘ Space, type “Terminal”, press Return), paste the command, press Return. It takes a few minutes.',
  },
  {
    id: 'linux',
    label: 'Ubuntu / Debian',
    command: 'sudo apt install ffmpeg',
    how: 'Open a terminal, paste, press Enter. It will ask for your password — that’s apt asking, not this app.',
  },
  {
    id: 'win32',
    label: 'Windows — via winget',
    command: 'winget install --id Gyan.FFmpeg',
    how: 'Open PowerShell (press ⊞ Win, type “PowerShell”, press Enter), paste, press Enter. Then restart this app — stop it with Ctrl+C in its window and run npm run web again — so it can see the new install.',
  },
];

export const osCommandFor = (platform: string | undefined): OsCommand =>
  OS_COMMANDS.find((o) => o.id === platform) ?? OS_COMMANDS[0];
