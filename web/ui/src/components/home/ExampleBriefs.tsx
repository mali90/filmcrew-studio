// First-run nudge: three example briefs that fill the hero's idea input. Lives on Home (next to
// the input it fills) and only while there are zero runs — after that the hero speaks for itself.
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';

const EXAMPLE_BRIEFS = [
  'A tiny robot waters a rooftop garden at sunrise',
  "A lighthouse keeper's last night before automation",
  'A cat reviews expensive cheese, deadpan',
];

export function ExampleBriefs({ onSuggest }: { onSuggest: (idea: string) => void }) {
  const runsQ = useQuery({ queryKey: ['runs'], queryFn: api.runs });
  if (runsQ.data == null || runsQ.data.runs.length > 0) return null;

  return (
    <section aria-label="Example ideas" className="text-center">
      <p className="mb-2 text-caption text-ink-muted">Try one of these to see how the studio works.</p>
      <div className="flex flex-wrap justify-center gap-2">
        {EXAMPLE_BRIEFS.map((brief) => (
          <button
            key={brief}
            type="button"
            onClick={() => onSuggest(brief)}
            className="h-7 rounded-full border border-line px-3 text-caption text-ink-secondary transition-colors duration-[120ms] hover:border-line-strong hover:bg-surface-2 hover:text-ink"
          >
            {brief}
          </button>
        ))}
      </div>
    </section>
  );
}
