// Home: the create hero, first-run example chips, the live queue strip, and a read-only Recent
// glimpse (the full grid lives on /library). The page owns the idea text so the example chips can
// fill the hero's input.
import { useRef, useState } from 'react';
import { CreateHero } from '../components/home/CreateHero';
import { ExampleBriefs } from '../components/home/ExampleBriefs';
import { QueueStrip } from '../components/home/QueueStrip';
import { RecentRuns } from '../components/home/RecentRuns';

export default function HomePage() {
  const [idea, setIdea] = useState('');
  const ideaRef = useRef<HTMLTextAreaElement>(null);

  return (
    <div className="flex flex-col gap-10">
      <CreateHero idea={idea} onIdeaChange={setIdea} ideaRef={ideaRef} />
      <ExampleBriefs
        onSuggest={(brief) => {
          setIdea(brief);
          ideaRef.current?.focus();
        }}
      />
      <QueueStrip />
      <RecentRuns />
      <p className="mt-4 text-center text-caption text-ink-faint">
        Make kind things — use real people&rsquo;s faces and voices only with their permission. What you
        create here is your responsibility, not the author&rsquo;s.
      </p>
    </div>
  );
}
