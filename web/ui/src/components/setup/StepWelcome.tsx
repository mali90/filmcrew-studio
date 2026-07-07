// Step 1 — welcome. Says what the tool does, what costs money, and what you'll need. Nothing else.
import { Button } from '../ui/Button';

export function StepWelcome({ onNext }: { onNext: () => void }) {
  return (
    <div>
      <h1 className="text-display text-ink">Make short videos from one-line ideas.</h1>
      <div className="mt-4 space-y-3 text-body text-ink-secondary">
        <p>
          Eight AI agents turn your idea into a production plan, fal.ai renders the clips, and ffmpeg
          stitches them into a finished video.
        </p>
        <p>
          Planning costs only your LLM usage (it depends on the provider, model and how you connect — API key or CLI plan). Rendering costs real money — a few dollars per video — and every
          paid button shows its price before you click.
        </p>
        <p>You&rsquo;ll need an LLM API key or a provider CLI, a fal.ai key, and ffmpeg installed.</p>
      </div>
      <div className="mt-8 flex justify-end">
        <Button variant="primary" size="lg" onClick={onNext}>Set up</Button>
      </div>
    </div>
  );
}
