// The editor's three promises, asserted rather than assumed:
// · the meter is in UTF-8 BYTES against the room left for YOUR words (`maxBytes − pinBytes`), so an
//   em dash costs 3 and an emoji 4 — counting characters is how a 480-character edit sails past a
//   500-byte cap and dies at the provider instead of here.
// · nothing is ever truncated for you. Over budget, the textarea keeps every byte you typed and Save
//   refuses out loud with the number (Don't #7).
// · where there is NO budget (`maxBytes: null` — Seedance's whole-prompt clamp ships off), the meter
//   degrades to a count and the editor gets out of the way. It may never refuse a save the renderer
//   would accept, and a missing denominator may never be shown as 0, NaN or Infinity.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PromptView } from '../../../../../shared/api-types';
import { http, HttpResponse, server } from '../../../test/msw';
import { promptView } from '../../../test/fixtures';
import { renderReview } from './test-helpers';
import { PromptEditor, roomFor, utf8Bytes } from './PromptEditor';

/** A Seedance view: one document per job, one budget, one textarea. */
const seedance = (over: Partial<PromptView> = {}): PromptView => promptView('K2', {
  backend: 'seedance-2.0@fal',
  endpointLabel: 'fal.ai Seedance 2.0',
  segments: null,
  segmentMaxBytes: null,
  shotPrompts: ['the lamp goes dark.'],
  prompt: 'Style: documentary.\n\nthe lamp goes dark.',
  draft: 'the lamp goes dark.',
  draftSegments: null,
  bytes: 4600,
  maxBytes: 5000,
  pinBytes: 1120,
  ...over,
});

function mount(view: PromptView, onClose = vi.fn()) {
  return { onClose, ...renderReview(<PromptEditor runId="r1" view={view} onClose={onClose} />) };
}

describe('PromptEditor', () => {
  it('meters the draft in BYTES against the room left for it — not characters, not the whole budget', async () => {
    const view = seedance();
    // 5,000 − 1,120: the system's front matter is not the user's to spend.
    expect(roomFor(view)).toEqual([3880]);
    mount(view);

    const box = screen.getByRole('textbox', { name: 'Prompt for K2' });
    const readout = screen.getByTestId('prompt-editor-bytes-K2');
    expect(readout).toHaveTextContent('19 / 3,880 B');

    // Four characters, ten bytes: é(2) + —(3) + œ(2) + 🌊(4). A character counter would say 4.
    await userEvent.clear(box);
    await userEvent.type(box, 'é—œ🌊');
    expect(utf8Bytes('é—œ🌊')).toBe(11); // 2 + 3 + 2 + 4 = 11 (the emoji is a surrogate pair)
    await waitFor(() => expect(readout).toHaveTextContent('11 / 3,880 B'));
  });

  it('warns from 90% of the room and fails over it, on the meter itself', async () => {
    // room = 100 B, so the arithmetic is legible: 90 warns, 101 is over.
    const view = seedance({ maxBytes: 1220, pinBytes: 1120, draft: 'x'.repeat(10) });
    expect(roomFor(view)).toEqual([100]);
    mount(view);

    const box = screen.getByRole('textbox', { name: 'Prompt for K2' });
    const readout = screen.getByTestId('prompt-editor-bytes-K2');
    expect(readout.className).not.toContain('text-status-warn');

    await userEvent.clear(box);
    await userEvent.paste('y'.repeat(90));
    await waitFor(() => expect(readout).toHaveTextContent('90 / 100 B'));
    expect(readout.className).toContain('text-status-warn');
    expect(readout.className).not.toContain('text-status-failed');

    await userEvent.paste('z'.repeat(11));
    await waitFor(() => expect(readout).toHaveTextContent('101 / 100 B'));
    expect(readout.className).toContain('text-status-failed');
  });

  it('over budget it keeps every byte you typed and refuses to save, with the number', async () => {
    const view = seedance({ maxBytes: 1220, pinBytes: 1120, draft: 'x'.repeat(10) });
    const submitted: unknown[] = [];
    server.use(http.put('/api/runs/:id/prompt', async ({ request }) => {
      submitted.push(await request.json());
      return HttpResponse.json(view);
    }));
    mount(view);

    const box = screen.getByRole('textbox', { name: 'Prompt for K2' });
    const tooLong = 'q'.repeat(114);
    await userEvent.clear(box);
    await userEvent.paste(tooLong);

    // Not one byte was cut: the text a user cannot see cut is the text they cannot fix.
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(tooLong));
    expect(utf8Bytes((box as HTMLTextAreaElement).value)).toBe(114);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Over by 14 B — trim to save.');
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await userEvent.click(save);
    expect(submitted).toHaveLength(0);
  });

  // Seedance ships with NO whole-prompt cap (no provider documents one), so the server sends
  // `maxBytes: null` and there is no denominator to meter against. `Math.max(0, 0 − pinBytes)` made
  // that read as room 0: every non-empty draft painted red, Save disabled, and a long prompt became
  // unsaveable — the exact opposite of removing the cap. With no limit the meter shows the COUNT.
  it('with no cap the meter is a plain byte COUNT, and a very long draft still saves', async () => {
    const view = seedance({ maxBytes: null, bytes: 1139, pinBytes: 1120 });
    expect(roomFor(view)).toEqual([null]);
    const bodies: string[] = [];
    server.use(http.put('/api/runs/:id/prompt', async ({ request }) => {
      const body = await request.json() as { job: string; prompt?: string };
      bodies.push(body.prompt ?? '');
      return HttpResponse.json({ ...view, source: 'override' });
    }));
    mount(view);

    const box = screen.getByRole('textbox', { name: 'Prompt for K2' }) as HTMLTextAreaElement;
    const readout = screen.getByTestId('prompt-editor-bytes-K2');
    const text = () => (readout.textContent ?? '').replace(/\s+/g, ' ').trim();
    expect(text()).toBe('19 B');

    const long = 'z'.repeat(20000);
    await userEvent.clear(box);
    await userEvent.paste(long);
    await waitFor(() => expect(text()).toBe('20,000 B'));

    // No denominator invented, and no arithmetic leaking out of one that does not exist.
    expect(text()).toMatch(/^[\d,]+ B$/);
    expect(text()).not.toContain('/');
    expect(text()).not.toMatch(/NaN|Infinity/);
    // No limit means nothing to be near, or over.
    expect(readout.className).not.toContain('text-status-warn');
    expect(readout.className).not.toContain('text-status-failed');
    expect(screen.queryByTestId('prompt-editor-over-K2')).not.toBeInTheDocument();

    // And the editor never blocks a save the renderer would accept.
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(bodies).toEqual([long]));
  });

  it('with no cap an empty draft is still refused — uncapped is not unvalidated', async () => {
    mount(seedance({ maxBytes: null, pinBytes: 1120 }));
    await userEvent.clear(screen.getByRole('textbox', { name: 'Prompt for K2' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
  });

  it('saves the WORDS, not the composed prompt — and says nothing was sent', async () => {
    const view = seedance();
    const bodies: string[] = [];
    server.use(http.put('/api/runs/:id/prompt', async ({ request }) => {
      const body = await request.json() as { job: string; prompt?: string };
      bodies.push(body.prompt ?? '');
      return HttpResponse.json({ ...view, source: 'override' });
    }));
    const { onClose } = mount(view);

    const box = screen.getByRole('textbox', { name: 'Prompt for K2' });
    await userEvent.clear(box);
    await userEvent.type(box, 'hold on the lamp.');
    // Free is honest here, and only here: one local file write, nothing submitted.
    expect(screen.getByText('Saving is free — nothing renders until you re-render K2.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodies).toEqual(['hold on the lamp.']));
    expect(onClose).toHaveBeenCalled();
  });

  it('a Kling run gets one textarea per shot, each with its own meter and the margin caption', async () => {
    // The fixture's K1 has two shots at 500 B, 64 of them already spoken for.
    const view = promptView('K1');
    expect(view.segments).toHaveLength(2);
    mount(view);

    const boxes = screen.getAllByRole('textbox');
    expect(boxes).toHaveLength(2);
    expect(screen.getByTestId('prompt-editor-bytes-K1-0')).toHaveTextContent(/\/ 436 B$/);
    expect(screen.getByTestId('prompt-editor-bytes-K1-1')).toHaveTextContent(/\/ 436 B$/);
    expect(screen.queryByTestId('prompt-editor-bytes-K1-2')).not.toBeInTheDocument();
    expect(screen.getByTestId('prompt-editor-total-K1')).toHaveTextContent('2 segments');
    expect(screen.getByTestId('prompt-editor-total-K1')).toHaveTextContent('/ 872 B');
    expect(screen.getByText('500 B per segment — Kling rejects at 512, so we keep a margin.')).toBeInTheDocument();

    // Each textarea opens on the AUTHORED body, never the composed segment: re-composing the lead
    // reference and framing over themselves would send them twice.
    expect((boxes[0] as HTMLTextAreaElement).value).toBe(view.draftSegments![0]);
    expect((boxes[0] as HTMLTextAreaElement).value).not.toContain('@Element1');
  });

  it('a Seedance run gets exactly one textarea for the whole job prompt', () => {
    mount(seedance());
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.queryByTestId('prompt-editor-total-K2')).not.toBeInTheDocument();
  });

  // The agents can (and on the golden spec do) write a body longer than the room left for it: the
  // composer clamps it, dropping framing and camera. Opening the editor on that must not read as a
  // broken editor — it is a choice the render is making, and now it is the user's to make instead.
  it('a plan already over its own budget is explained, not blamed on the reader', () => {
    mount(seedance({ maxBytes: 1220, pinBytes: 1120, draft: 'x'.repeat(150) }));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Over by 50 B — trim to save.');
    expect(alert).toHaveTextContent(/The agents wrote it that way, and the render trims it to fit/);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('names the shot that is over when there is more than one', async () => {
    mount(promptView('K1'));
    const boxes = screen.getAllByRole('textbox');
    await userEvent.clear(boxes[1]);
    await userEvent.paste('w'.repeat(437));
    expect(await screen.findByRole('alert')).toHaveTextContent('Shot 2 is over by 1 B — trim to save.');
  });

  // ── stale (spec D22) ──────────────────────────────────────────────────────────────────────────

  const staleView = () => seedance({
    source: 'override',
    stale: true,
    draft: 'my own quieter version.',
    planDraft: 'the agents’ newly revised block.',
    planPrompt: 'Style: documentary.\n\nthe agents’ newly revised block.',
  });

  it('says what a stale edit still does — send your words — and offers the two ways out', () => {
    mount(staleView());
    expect(screen.getByTestId('prompt-stale-K2')).toHaveTextContent(
      "The agents revised the plan after you edited K2's prompt. Your edit is still what we'll send, word for word.",
    );
    expect(screen.getByRole('button', { name: 'Refresh from plan' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard edit' })).toBeInTheDocument();
  });

  it('Refresh from plan loads the new plan text into the editor — UNSAVED', async () => {
    const submitted: unknown[] = [];
    server.use(http.put('/api/runs/:id/prompt', async ({ request }) => {
      submitted.push(await request.json());
      return HttpResponse.json(staleView());
    }));
    mount(staleView());

    const box = screen.getByRole('textbox', { name: 'Prompt for K2' }) as HTMLTextAreaElement;
    expect(box.value).toBe('my own quieter version.');
    await userEvent.click(screen.getByRole('button', { name: 'Refresh from plan' }));
    await waitFor(() => expect(box.value).toBe('the agents’ newly revised block.'));
    // Loading is not saving: nothing left the browser, and Save is still there to be pressed.
    expect(submitted).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('Discard edit confirms first, and only then deletes', async () => {
    const deleted: string[] = [];
    server.use(http.delete('/api/runs/:id/prompt', ({ request }) => {
      deleted.push(new URL(request.url).searchParams.get('job') ?? '');
      return HttpResponse.json({ ...seedance(), source: 'plan' });
    }));
    const { onClose } = mount(staleView());

    await userEvent.click(screen.getByRole('button', { name: 'Discard edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Discard your edit to K2?' });
    expect(dialog).toHaveTextContent('K2 goes back to the prompt the agents wrote. Your edited text is not kept.');
    expect(deleted).toHaveLength(0);

    // Keeping is the safe default — it must genuinely keep.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(deleted).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Discard edit' }));
    const again = await screen.findByRole('dialog');
    await userEvent.click(within(again).getByRole('button', { name: 'Discard edit' }));
    await waitFor(() => expect(deleted).toEqual(['K2']));
    expect(onClose).toHaveBeenCalled();
  });

  it('never calls a paid thing free: the only "free" on screen is the local save', () => {
    mount(seedance());
    const free = screen.getAllByText(/\bfree\b/i).map((el) => el.textContent);
    expect(free).toEqual(['Saving is free — nothing renders until you re-render K2.']);
  });
});
