// The WS2 walkthrough, driven through the real UI against the zero-spend demo: read the prompt a
// segment would be sent, edit it, plan a frame-conditioned re-render and back out of it, deliver the
// run, reopen it, and deliver again.
//
// It runs against the SEEDED run rather than a freshly planned one, because everything below only
// exists on a cut whose clips came from different takes: the continuity chips need a join that is
// broken, the version picker needs a take that really sent something, and the re-render dialog needs
// a neighbour on each side. Planning and rendering that by hand takes two minutes of mock renders
// per spec run and still lands on an all-intact chain.
//
// The spend assertions are the point of doing it here at all. Every lower-altitude test can only
// say "the component did not call the mutation"; this one asks the PROVIDER MOCKS how many render
// submits they took, either side of the whole walkthrough. Previewing a prompt, saving an edit,
// opening and cancelling a paid dialog, approving, reopening and re-approving must move that number
// by exactly zero.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/__demo/env-reset', { data: { complete: true } });
  await request.post('/__demo/fal-opts', { data: { validationFail: false, authFail: false } });
  // The walkthrough approves and reopens the seeded run, so it puts it back first — a re-run against
  // a demo server that was left up must start from the same place as a cold one.
  await request.post('/__demo/reseed');
});

test('prompt preview → edit → re-render dialog (cancelled) → approve → reopen → replace final', async ({ page, request }) => {
  const health = await (await request.get('/__demo/health')).json();
  const runId: string = health.seededRun;
  const submits = async () => (await request.get('/__demo/submits')).json();
  const before = await submits();

  await page.goto(`/runs/${runId}`);

  // ── the review strip draws the joins, and names the broken one ───────────────────────────────
  const strip = page.getByTestId('clip-strip');
  await expect(strip).toBeVisible();
  await expect(page.getByTestId('segment-tile-K1')).toBeVisible();
  // K2 was re-rendered under K3: the first join holds, the second does not. Both connectors are
  // drawn, so a regression that flattened the cut back to "all intact" fails here.
  await expect(strip.getByTestId('clip-joint-linked')).toHaveCount(1);
  await expect(strip.getByTestId('clip-joint-broken')).toHaveCount(1);
  await expect(page.getByTestId('segment-tile-K3')).toContainText(/join broken/i);
  await expect(page.getByTestId('clip-strip-explanation')).toContainText(/K3/);

  // ── the prompt sheet: what would be sent, metered in the unit the model counts ───────────────
  await page.getByTestId('segment-tile-K2').click();
  await page.getByRole('button', { name: 'Prompt for K2' }).click();
  const sheet = page.getByTestId('prompt-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId('prompt-bytes-K2')).toContainText(/\d+\s*\/\s*\d+\s*B/);

  // ── edit it: saved verbatim, and the tile says so without opening anything ───────────────────
  await sheet.getByRole('button', { name: /edit prompt/i }).click();
  const editor = page.getByTestId('prompt-editor-K2');
  await expect(editor).toBeVisible();
  const words = 'The keeper wipes the lens slowly, humming to himself in the lamplight.';
  await editor.getByRole('textbox').first().fill(words);
  await editor.getByRole('button', { name: /^save$/i }).click();
  await expect(sheet.getByTestId('prompt-edited-chip-K2')).toBeVisible();
  await expect(sheet).toContainText(words);
  // the pen overlay (spec D8/D22) — the strip carries the fact back out of the sheet
  await expect(page.getByTestId('segment-tile-K2').getByTestId('tile-prompt-overlay')).toBeVisible();

  // ── the re-render dialog: read the boundary plan, then back out ──────────────────────────────
  await page.getByTestId('segment-actions').getByRole('button', { name: /^re-render K2$/i }).click();
  const dialog = page.getByRole('dialog', { name: /re-render K2/i });
  await expect(dialog).toBeVisible();
  // The sentence names the neighbours it would pin to, in plain words, before anything is spent.
  const plan = dialog.getByTestId('boundary-plan-sentence');
  await expect(plan).toBeVisible();
  await expect(plan).toContainText(/K1/);
  await expect(plan).toContainText(/frame/i);
  // "Seamless" is only ever said of a native anchor; whatever this backend does, the sentence must
  // not promise more than the renderer's own rule allows.
  await expect(plan).not.toContainText(/guaranteed/i);
  await dialog.getByRole('button', { name: /^cancel$/i }).click();
  await expect(dialog).toBeHidden();
  expect(await submits(), 'reading a prompt, saving an edit and cancelling a paid dialog spend nothing').toEqual(before);

  // ── deliver ──────────────────────────────────────────────────────────────────────────────────
  await page.getByRole('button', { name: /^approve$/i }).click();
  await expect(page.getByText(/is done/i).first()).toBeVisible({ timeout: 60_000 });
  const download = page.getByRole('link', { name: /download/i });
  await expect(download).toHaveAttribute('href', /\/api\/media\/out\//);

  // ── reopen: the question is about what does NOT happen ───────────────────────────────────────
  await page.getByRole('button', { name: /make changes/i }).click();
  await expect(page.getByText(/stays on disk and stays downloadable/i)).toBeVisible();
  await page.getByRole('button', { name: /make changes/i }).click();

  // back in review, and the run explains itself where the user lands rather than in a toast
  await expect(page.getByTestId('clip-strip')).toBeVisible({ timeout: 30_000 });
  const replace = page.getByRole('button', { name: /replace final/i });
  await expect(replace).toBeVisible();
  await expect(page.getByText(/stays on disk/i).first()).toBeVisible();

  // ── deliver again: a new final BESIDE the first, never over it ───────────────────────────────
  await replace.click();
  await expect(page.getByText(/is done/i).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('finals-lineage')).toContainText(/final-2 · replaced final-1/);
  await page.getByRole('button', { name: /earlier finals/i }).click();
  await expect(page.getByRole('link', { name: /final-1/ })).toBeVisible();

  expect(await submits(), 'the whole walkthrough asked no provider for a render').toEqual(before);
});
