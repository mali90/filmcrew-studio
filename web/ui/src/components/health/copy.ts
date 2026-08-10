// Web-native voice for the health checks. preflight.js's hints are written for a terminal
// ("put it in .env", "npm run mint-voice") — meaningless words inside an app that HAS a key
// form, a Cast page and an env editor. The web surfaces map each check's stable id to copy and
// a fix action; the CLI keeps its own dialect untouched.
import type { CheckId, DoctorReport } from '../../../../shared/api-types';

type Check = DoctorReport['checks'][number];

/** The hint shown under a FAILED row, in the app's own vocabulary. */
export function webHint(c: Check, context: 'wizard' | 'settings'): string {
  switch (c.id) {
    case 'fal-key':
      // Soft ⇒ nothing in this setup renders, upscales or uploads on fal (a Segmind-only install).
      return c.soft
        ? 'Optional here — nothing in your setup runs on fal. You’d need it to mint character voices, or to switch to a fal backend.'
        : 'The render key is missing or invalid.';
    case 'segmind-key':
      return c.soft
        ? 'Optional here — you’d need it only if you switch a run to a Segmind backend.'
        : 'Your render backend runs on Segmind. Add SEGMIND_API_KEY to .env — get one from segmind.com (Console → API keys).';
    case 'render-assets':
      return 'Segmind fetches your reference images from fal storage, which needs a fal key. Add one, or set SEGMIND_UPLOAD_MODE=data-uri in .env to send the references inline instead — that path needs no fal account.';
    case 'llm':
      if (/CLI/i.test(c.label)) return 'The planner CLI didn’t respond — it may not be installed or logged in.';
      if (/valid/.test(c.label)) return 'That planner isn’t one this app knows.';
      return 'No working key saved for the planner.';
    case 'backend': return 'That render backend isn’t one this app knows.';
    case 'upscale-provider': return 'UPSCALE_PROVIDER in .env isn’t a provider this app knows. Use auto (upscale wherever the run rendered), fal, or segmind.';
    case 'ffmpeg': return 'Not found on this machine. It assembles your clips into the finished video.';
    case 'ffprobe': return 'Ships with ffmpeg — the install above covers it.';
    // Soft: the render still finishes, it just looks worse at the seams. The number lives in the
    // check's own label, so this says what it costs and who does the updating.
    case 'ffmpeg-version':
      return 'Your ffmpeg is too old for the crossfade the seamless stitcher uses, so long cuts join with a hard cut at every seam. Update it yourself (macOS: brew upgrade ffmpeg · Windows: winget upgrade Gyan.FFmpeg) — the app never installs or updates ffmpeg.';
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

/**
 * Which wizard step (or settings card) owns the fix for a hard check. A check belongs here ONLY
 * when the app really can fix it in place — a "Fix key" button that lands on a form without the
 * field is worse than the hint, which at least names the .env variable to set.
 *
 * `segmind-key` earns its entry now that BOTH destinations have the field (the wizard's key step
 * shows the Segmind branch whenever the chosen backend renders there, and the Keys card grew one).
 * The row only ever offers the button when it is HARD, which is precisely the Segmind-backend case
 * — a soft row is a fal user being told about a provider they never chose, and jumping them to a
 * key form would be noise.
 *
 * `render-assets` stays absent: its fix is SEGMIND_UPLOAD_MODE, and no surface exposes an upload-
 * mode control. Add that entry the moment one does.
 */
export const FIX_TARGET: Partial<Record<CheckId, { step: 'llm' | 'fal' | 'backend'; wizardLabel: string; settingsLabel: string; settingsAnchor: string }>> = {
  'fal-key': { step: 'fal', wizardLabel: 'Fix key', settingsLabel: 'Fix in Keys', settingsAnchor: 'keys-heading' },
  'segmind-key': { step: 'fal', wizardLabel: 'Fix key', settingsLabel: 'Fix in Keys', settingsAnchor: 'keys-heading' },
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
