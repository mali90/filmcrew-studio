// How a render job's cast is read off the spec — shared by EVERY renderer, on every provider.
//
// These two helpers answer "who speaks in this job?" and "which images belong to which character?".
// Both are pure spec reading: no endpoint, no transport, no provider. They used to live in
// fal-kling.js (which still re-exports them, so no import path changed), but a provider-neutral
// renderer must not import a fal module to ask a question about the spec — that is what dragged
// fal.js, and transitively config.fal, into src/lib/render-seedance.js.
import { slug } from './util.js';

/** Distinct speaker names among a job's VO lines (first-seen order, first-seen casing). Deduped by
 *  slug — the voice registry and the element/audio-ref maps all match speakers slug-wise, so "Host"
 *  and "host" are the same character and must not count twice. */
export function jobSpeakers(job, spec) {
  const seen = new Map();
  for (const l of spec.audio?.voice?.lines ?? []) {
    if (!job.shots.includes(l?.shot_id) || !(l?.text ?? '').trim() || !l?.speaker) continue;
    if (!seen.has(slug(l.speaker))) seen.set(slug(l.speaker), l.speaker);
  }
  return [...seen.values()];
}

/**
 * Group a job's spec elements into one group per character. If any element carries a `character`
 * field, group by it (multi-character); otherwise all of the job's images form ONE group named after
 * the job's sole speaker (or 'subject'). Each group → @Element{index} on models with native elements
 * (Kling), or a run of flat @ImageN refs on models without them (Seedance).
 */
export function characterGroups(job, spec) {
  const roster = spec.kling.elements ?? [];
  const ids = job.elements?.length ? job.elements : roster.map((e) => e.id);
  const els = ids.map((id) => {
    const e = roster.find((r) => r.id === id);
    if (!e) throw new Error(`job ${job.job_id}: element id "${id}" not in spec.kling.elements`);
    return e;
  });
  if (els.some((e) => e.character)) {
    const m = new Map();
    for (const e of els) { const c = e.character || e.id; if (!m.has(c)) m.set(c, []); m.get(c).push(e); }
    return [...m.entries()].map(([name, list]) => ({ name, els: list }));
  }
  const speakers = jobSpeakers(job, spec);
  return [{ name: speakers.length === 1 ? speakers[0] : 'subject', els }];
}

export default { jobSpeakers, characterGroups };
