// Step 8 — done. One sentence, one button, straight into the studio.
import { CheckCircle2 } from 'lucide-react';
import { Button } from '../ui/Button';

export function StepDone({ onFinish }: { onFinish: () => void }) {
  return (
    <div className="py-6 text-center">
      <CheckCircle2 size={28} className="mx-auto text-status-done" aria-hidden />
      <h1 className="mt-4 text-display text-ink">You&rsquo;re set.</h1>
      <p className="mt-2 text-body text-ink-secondary">
        Your settings are saved and the pipeline is healthy.
      </p>
      <p className="mx-auto mt-4 max-w-[440px] text-caption text-ink-muted">
        One small ask before you start: make kind things. Real people&rsquo;s faces and voices belong to
        them — and what you create is yours to answer for.
      </p>
      <div className="mt-8 flex flex-col items-center gap-3">
        <Button variant="primary" size="lg" onClick={onFinish}>Create your first video</Button>
        <a href="/cast" className="text-caption text-accent transition-colors duration-[120ms] hover:text-accent-hover">
          Set up your cast first
        </a>
      </div>
    </div>
  );
}
