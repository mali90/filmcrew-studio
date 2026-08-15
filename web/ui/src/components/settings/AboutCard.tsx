// About — the quiet footer card: version, where the code lives, what leaves the machine.
// The version is read from the ROOT package.json at build time — `npm version` during a release is
// then its only writer, so this card cannot drift from the shipped version again (as prose it sat
// at v1.1.0 through three releases). AboutCard.test.tsx pins the linkage.
import { version } from '../../../../../package.json';

export function AboutCard() {
  return (
    <section aria-labelledby="about-heading" className="rounded-r3 border border-line bg-surface-1 p-5">
      <h2 id="about-heading" className="text-heading text-ink">About</h2>
      <p className="mt-2 text-dense text-ink-secondary">
        Filmcrew Studio <span className="tnum font-mono">v{version}</span>
      </p>
      <p className="mt-1.5 text-dense text-ink-secondary">
        <a
          href="https://github.com/mali90/filmcrew-studio"
          target="_blank"
          rel="noreferrer"
          className="text-accent hover:text-accent-hover"
        >
          GitHub repo
        </a>
        <span className="text-ink-faint"> · </span>
        provider setup notes live in <span className="font-mono">docs/PROVIDERS.md</span>.
      </p>
      <p className="mt-1.5 text-caption text-ink-muted">
        Videos are generated at your direction — you&rsquo;re responsible for what you create and how you
        share it, not the tool&rsquo;s author.
      </p>
      <p className="mt-1.5 text-caption text-ink-muted">
        Source-available (FSL-1.1) · no telemetry — everything runs on your machine except fal.ai and your LLM provider.
      </p>
    </section>
  );
}
