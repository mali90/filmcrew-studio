// The prompt sheet is the screen where the app proves it is not hiding anything: the exact words
// that will leave for the provider, the size of them against the model's real budget, and — for a
// take that already rendered — what was actually sent, to whom, and when.
//
// Two rules are load-bearing here and are asserted rather than assumed:
//   · every number comes from the API. A byte count recomputed in the browser would be a second
//     implementation of the one thing this screen promises not to have.
//   · nothing in this phase is editable, and nothing here is called "free" (Don't #4).
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptView } from '../../../../../shared/api-types';
import { http, HttpResponse, server } from '../../../test/msw';
import { makeRun, promptView, sentPromptView } from '../../../test/fixtures';
import { markPaidConfirmed, renderRunPage } from '../test-harness';

/** Serve the prompt endpoints from a map keyed `<job>` (the plan) and `<job>@<take>` (as sent). */
function servePrompts(views: Record<string, PromptView>) {
  server.use(
    http.get('/api/runs/:id/prompt', ({ request }) => {
      const q = new URL(request.url).searchParams;
      const key = q.get('take') ? `${q.get('job')}@${q.get('take')}` : String(q.get('job'));
      const view = views[key];
      return view
        ? HttpResponse.json(view)
        : HttpResponse.json({ error: `no prompt for ${key}`, hint: 'pick another version' }, { status: 404 });
    }),
    http.get('/api/runs/:id/prompts', ({ params }) => {
      const plan = Object.entries(views).filter(([k]) => !k.includes('@')).map(([, v]) => v);
      return HttpResponse.json({ runId: String(params.id), backend: 'kling-o3@fal', jobs: plan.map((v) => v.jobId), prompts: plan, orphaned: [] });
    }),
  );
}

/** Open the sheet from the clip strip: pick K2, then its `[Prompt]` control. */
async function openFromStrip(jobId = 'K2') {
  await userEvent.click(await screen.findByRole('button', { name: `Play from ${jobId}` }));
  const toggle = await screen.findByRole('button', { name: `Prompt for ${jobId}` });
  await userEvent.click(toggle);
  return toggle;
}

beforeEach(() => markPaidConfirmed());

describe('PromptSheet', () => {
  it('is a disclosure: the control flips aria-expanded and reveals the panel it names', async () => {
    renderRunPage(makeRun('review'));
    await screen.findByRole('region', { name: 'Review stage' });

    // Nothing is on screen until a segment is picked — selection reveals the actions (spec D11).
    expect(screen.queryByRole('button', { name: 'Prompt for K2' })).not.toBeInTheDocument();

    const toggle = await openFromStrip('K2');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panelId = toggle.getAttribute('aria-controls')!;
    expect(panelId).toBeTruthy();
    const panel = await waitFor(() => {
      const el = document.getElementById(panelId);
      expect(el).not.toBeNull();
      return el!;
    });
    expect(panel).toHaveAttribute('aria-label', 'Prompt for K2');
    // It is an inline disclosure, not a modal: no dialog, no scrim (Don't #2).
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById(panelId)).toBeNull();
  });

  it('shows the job\'s own prompt body and the reference legend that rides with it', async () => {
    renderRunPage(makeRun('review'));
    await screen.findByRole('region', { name: 'Review stage' });
    await openFromStrip('K2');

    const panel = await screen.findByTestId('prompt-sheet');
    expect(within(panel).getByTestId('prompt-body-K2-0')).toHaveTextContent('At first light the lamp goes dark');
    // D20: what is sent with every prompt for this job, and cannot be edited away.
    expect(panel).toHaveTextContent('Sent with every K2 prompt — not editable');
    expect(panel).toHaveTextContent('@Element1 = the lighthouse keeper');
    // Opening the sheet still only READS: editing is offered, never entered on your behalf.
    expect(within(panel).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /edit prompt/i })).toBeInTheDocument();
  });

  it('the version picker lists Current plan plus one entry per take that kept a prompts.json', async () => {
    servePrompts({
      K2: promptView('K2', { availableTakes: ['t2', 't1'] }),
      'K2@t2': sentPromptView('K2', 't2'),
      'K2@t1': sentPromptView('K2', 't1'),
    });
    renderRunPage(makeRun('review'));
    await screen.findByRole('region', { name: 'Review stage' });
    await openFromStrip('K2');

    const picker = await screen.findByRole('radiogroup', { name: 'Prompt version' });
    expect(within(picker).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Current plan', 'take t2', 'take t1']);

    await userEvent.click(within(picker).getByRole('radio', { name: 'take t1' }));
    const panel = screen.getByTestId('prompt-sheet');
    await waitFor(() => expect(panel).toHaveTextContent('the words take t1 really sent for K2'));
    // A past take is immutable — no editing affordance of any kind (spec D22 as-sent).
    expect(within(panel).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /edit|save|use this as my draft/i })).not.toBeInTheDocument();
  });

  it('a run that has sent nothing yet gets a static label, not a one-segment control', async () => {
    renderRunPage(makeRun('review')); // default handler: availableTakes []
    await screen.findByRole('region', { name: 'Review stage' });
    await openFromStrip('K2');

    const panel = await screen.findByTestId('prompt-sheet');
    expect(within(panel).queryByRole('radiogroup', { name: 'Prompt version' })).not.toBeInTheDocument();
    expect(panel).toHaveTextContent('Current plan');
  });

  it('the byte readout is the API\'s own count against the API\'s own budget, and warns from 90%', async () => {
    // A Seedance run: one prompt per job, one budget — 4,600 of 5,000 bytes is 92%.
    const seedance = promptView('K2', {
      backend: 'seedance-2.0@fal',
      endpointLabel: 'fal.ai Seedance 2.0',
      segments: null,
      segmentMaxBytes: null,
      prompt: 'Shot 1: the lamp goes dark.',
      bytes: 4600,
      maxBytes: 5000,
      pinBytes: 1120,
    });
    servePrompts({ K2: seedance });
    renderRunPage(makeRun('review'));
    await screen.findByRole('region', { name: 'Review stage' });
    await openFromStrip('K2');

    const readout = await screen.findByTestId('prompt-bytes-K2');
    // 4,600 is not the length of the body on screen — the count is the server's, not the browser's.
    expect(readout).toHaveTextContent('4,600 / 5,000 B');
    expect(readout.className).toContain('text-status-warn');
  });

  it('a Kling run meters every segment separately, against the 500 B the model really enforces', async () => {
    renderRunPage(makeRun('review'));
    await screen.findByRole('region', { name: 'Review stage' });
    await openFromStrip('K1'); // K1 covers S1 and S2 — two segments

    const panel = await screen.findByTestId('prompt-sheet');
    expect(within(panel).getByTestId('prompt-bytes-K1-0')).toHaveTextContent(/\/ 500 B$/);
    expect(within(panel).getByTestId('prompt-bytes-K1-1')).toHaveTextContent(/\/ 500 B$/);
    expect(within(panel).queryByTestId('prompt-bytes-K1-2')).not.toBeInTheDocument();
    expect(panel).toHaveTextContent('2 segments');
    expect(panel).toHaveTextContent('500 B per segment — Kling rejects at 512, so we keep a margin.');
  });

  it('says what editing would do, names the real provider for a past take, and never says "free"', async () => {
    servePrompts({
      K2: promptView('K2', { availableTakes: ['t1'] }),
      'K2@t1': sentPromptView('K2', 't1', { endpointLabel: 'fal.ai Seedance 2.0', backend: 'seedance-2.0@fal' }),
    });
    renderRunPage(makeRun('review'));
    await screen.findByRole('region', { name: 'Review stage' });
    await openFromStrip('K2');

    const panel = await screen.findByTestId('prompt-sheet');
    expect(panel).toHaveTextContent("Editing changes only the words we send to the model. It doesn't re-run the agents.");

    await userEvent.click(within(panel).getByRole('radio', { name: 'take t1' }));
    // The provider is whatever THAT take recorded, quoted from the API — never today's default.
    await waitFor(() => expect(panel).toHaveTextContent(
      "Exactly what we sent to fal.ai Seedance 2.0 for this take. Past takes can't be edited.",
    ));
    // …with when it was sent, in which take, and that take's own estimate.
    expect(within(panel).getByTestId('prompt-sent-chip-K2')).toHaveTextContent('take t1');
    expect(within(panel).getByTestId('prompt-sent-chip-K2')).toHaveTextContent('≈$4.20');

    // Nothing on this screen is called free — only a purely local action may ever wear that word.
    expect(panel.textContent ?? '').not.toMatch(/\bfree\b/i);
  });

  it('copies the exact body the server sent, and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const view = promptView('K2');
    servePrompts({ K2: view });
    renderRunPage(makeRun('review'));
    await screen.findByRole('region', { name: 'Review stage' });
    await openFromStrip('K2');

    await userEvent.click(await screen.findByRole('button', { name: "Copy K2's prompt" }));
    expect(writeText).toHaveBeenCalledWith(view.prompt);
    expect(await screen.findByText("K2's prompt copied to your clipboard.")).toBeInTheDocument();
  });

  it('opens from the plan card with every job of the plan, before a penny is spent', async () => {
    renderRunPage(makeRun('plan-ready'));
    await screen.findByRole('region', { name: 'The plan is ready' });

    const toggle = screen.getByRole('button', { name: 'Prompts for this plan' });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const panel = await screen.findByTestId('prompt-sheet');
    expect(panel).toHaveAttribute('aria-label', 'Prompts for this plan');
    expect(await within(panel).findByRole('article', { name: 'Prompt for K1' })).toBeInTheDocument();
    expect(within(panel).getByRole('article', { name: 'Prompt for K2' })).toBeInTheDocument();
  });

  it('opens from a job card while that job renders', async () => {
    renderRunPage(makeRun('rendering'));
    await screen.findByRole('region', { name: 'Render jobs' });

    const toggle = within(screen.getByLabelText('Job K1')).getByRole('button', { name: 'Prompt for K1' });
    await userEvent.click(toggle);

    const panel = await screen.findByTestId('prompt-sheet');
    expect(panel).toHaveAttribute('aria-label', 'Prompt for K1');
    // One panel, wherever it was opened from — the job cards do not each grow their own.
    expect(screen.getAllByTestId('prompt-sheet')).toHaveLength(1);
  });

  it('surfaces a job the plan cannot compose instead of showing an empty prompt', async () => {
    servePrompts({
      K2: promptView('K2', {
        segments: null, shotPrompts: null, refs: [], prompt: '', bytes: 0, maxBytes: 0, segmentMaxBytes: null, pinBytes: 0,
        error: 'shot S9 is not in this plan',
      }),
    });
    renderRunPage(makeRun('review'));
    await screen.findByRole('region', { name: 'Review stage' });
    await openFromStrip('K2');

    expect(await screen.findByTestId('prompt-sheet')).toHaveTextContent('shot S9 is not in this plan');
  });

  it('a job the plan cannot compose is not editable — there are no words to hand an editor', async () => {
    servePrompts({
      K2: promptView('K2', {
        segments: null, shotPrompts: null, refs: [], prompt: '', bytes: 0, maxBytes: 0, segmentMaxBytes: null, pinBytes: 0,
        error: 'shot S9 is not in this plan',
      }),
    });
    renderRunPage(makeRun('review'));
    await screen.findByRole('region', { name: 'Review stage' });
    await openFromStrip('K2');

    const panel = await screen.findByTestId('prompt-sheet');
    expect(within(panel).queryByRole('button', { name: /edit prompt/i })).not.toBeInTheDocument();
  });

  // ── P4: editing ───────────────────────────────────────────────────────────────────────────────

  /** The plan's view until a PUT lands, the saved override afterwards — as the real server behaves. */
  function serveEditable(jobId = 'K2') {
    let saved: string[] | null = null;
    const viewNow = () => (saved
      ? promptView(jobId, { source: 'override', draftSegments: saved, updatedAt: '2026-07-04T10:00:00.000Z' })
      : promptView(jobId));
    server.use(
      http.get('/api/runs/:id/prompt', () => HttpResponse.json(viewNow())),
      http.get('/api/runs/:id/prompts', ({ params }) => HttpResponse.json({
        runId: String(params.id), backend: 'kling-o3@fal', jobs: [jobId], prompts: [viewNow()], orphaned: [],
      })),
      http.put('/api/runs/:id/prompt', async ({ request }) => {
        saved = ((await request.json()) as { segments?: string[] }).segments ?? null;
        return HttpResponse.json(viewNow());
      }),
    );
    return { savedNow: () => saved };
  }

  it('saving flips the sheet to the saved state: an edited chip, and what it means for the next render', async () => {
    const { savedNow } = serveEditable('K2');
    renderRunPage(makeRun('review'));
    await screen.findByRole('region', { name: 'Review stage' });
    await openFromStrip('K2');

    const panel = await screen.findByTestId('prompt-sheet');
    expect(within(panel).queryByTestId('prompt-edited-chip-K2')).not.toBeInTheDocument();

    await userEvent.click(within(panel).getByRole('button', { name: /edit prompt/i }));
    const boxes = within(panel).getAllByRole('textbox');
    await userEvent.clear(boxes[0]);
    await userEvent.type(boxes[0], 'hold on the lamp until it fails.');
    await userEvent.click(within(panel).getByRole('button', { name: 'Save' }));

    // The words that left the browser are the user's own — not the composed prompt around them.
    await waitFor(() => expect(savedNow()?.[0]).toBe('hold on the lamp until it fails.'));
    expect(await within(panel).findByTestId('prompt-edited-chip-K2')).toHaveTextContent('edited');
    await waitFor(() => expect(panel).toHaveTextContent("Your edit is what K2's next render sends."));
    // Back to reading: the editor closed itself, and nothing on this screen was paid for.
    expect(within(panel).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(panel).getByTestId('prompt-body-K2-0')).toBeInTheDocument();
  });

  it('an edit the plan has moved under opens IN the editor, banner first', async () => {
    servePrompts({
      K2: promptView('K2', {
        source: 'override',
        stale: true,
        planSegments: ['@Element1 the agents’ new words'],
        planDraftSegments: ['the agents’ new words'],
      }),
    });
    renderRunPage(makeRun('review'));
    await screen.findByRole('region', { name: 'Review stage' });
    await openFromStrip('K2');

    const panel = await screen.findByTestId('prompt-sheet');
    expect(await within(panel).findByTestId('prompt-stale-K2')).toHaveTextContent(
      "The agents revised the plan after you edited K2's prompt. Your edit is still what we'll send, word for word.",
    );
    expect(within(panel).getAllByRole('textbox').length).toBeGreaterThan(0);
  });

  it('an edit whose segment the agents re-cut away is kept, and said out loud', async () => {
    server.use(http.get('/api/runs/:id/prompts', ({ params }) => HttpResponse.json({
      runId: String(params.id),
      backend: 'kling-o3@fal',
      jobs: ['K1', 'K2'],
      prompts: [promptView('K1'), promptView('K2')],
      orphaned: [{ jobId: 'K4', prompt: 'the words for a segment that no longer exists', updatedAt: null }],
    })));
    renderRunPage(makeRun('plan-ready'));
    await screen.findByRole('region', { name: 'The plan is ready' });
    await userEvent.click(screen.getByRole('button', { name: 'Prompts for this plan' }));

    const panel = await screen.findByTestId('prompt-sheet');
    const row = within(panel).getByTestId('prompt-orphaned');
    expect(row).toHaveTextContent('1 edited prompt has no segment any more.');
    await userEvent.click(within(row).getByRole('button', { name: /has no segment any more/ }));
    expect(row).toHaveTextContent('K4 no longer exists in this plan');
    expect(row).toHaveTextContent('the words for a segment that no longer exists');
  });
});
