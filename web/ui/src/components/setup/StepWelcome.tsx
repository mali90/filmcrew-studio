// Step 1 — welcome. Says what the tool does, what costs money, and what you'll need. Nothing else.
// Provider names live in prose here and go stale silently — this page claimed "fal.ai renders the
// clips" for two providers' worth of releases. StepWelcome.test.tsx pins it against the registry.
import { Button } from '../ui/Button';

export function StepWelcome({ onNext }: { onNext: () => void }) {
  return (
    <div>
      <h1 className="text-display text-ink">Make short videos from one-line ideas.</h1>
      <div className="mt-4 space-y-3 text-body text-ink-secondary">
        <p>
          Eight AI agents turn your idea into a production plan, the render provider you pick makes
          the clips, and ffmpeg stitches them into a finished video.
        </p>
        <p>
          Planning bills your LLM usage — how much depends on the provider, the model and how you
          connect (API key or CLI plan). Rendering costs real money — a few dollars per video — and
          every paid button shows its price before you click.
        </p>
        <p>
          The same model can bill very differently from one render provider to the next, so the
          render step quotes each one&rsquo;s per-second estimate and marks the lowest.
        </p>
        <p>
          You&rsquo;ll need an LLM API key or a provider CLI, a key for whichever render provider you
          pick — fal.ai or Segmind — and ffmpeg installed.
        </p>
      </div>
      <div className="mt-8 flex justify-end">
        <Button variant="primary" size="lg" onClick={onNext}>Set up</Button>
      </div>
    </div>
  );
}
