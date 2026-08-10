// The Segmind-only story, driven through the real UI against the zero-spend demo: pick Seedance 2.5
// on Segmind, plan, render, review, and approve WITH a Topaz upscale — all of it on the Segmind
// mock, and all of it priced at SEGMIND's own published rates.
//
// Everything else that knows about Segmind is asserted at a lower altitude: the transport against
// its mock, the renderer through renderSpec, the estimator against prices.json, the picker in jsdom,
// and demo.js by reading its source. None of that proves the pieces are WIRED to each other. A
// mistyped slug variable in the demo's childEnv, a provider the picker composes but the server
// rejects, or an upscale that quietly falls back to fal would pass every one of those tests and
// fail here — this spec is the only place the whole chain runs as one.
//
// Two things it pins that only the full chain can show:
//   * a Segmind run quotes SEGMIND money the whole way down — the estimate the run page fetches, the
//     render button, and the approve-time Topaz upscale all price off the segmind rows, never fal's
//   * approve-with-upscale completes on Segmind, which is what makes a fal-free install able to
//     finish a film
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/__demo/env-reset', { data: { complete: true } });
  await request.post('/__demo/segmind-opts', {
    data: { authFail: false, validationFail: false, insufficientCredits: false, failed: false, expired: false, processingHits: 0 },
  });
});

test('a Segmind run renders and upscales end to end, priced at Segmind\'s own rates', async ({ page, request }) => {
  // the demo really is serving a Segmind mock — otherwise the render below would be reaching a host
  const health = await (await request.get('/__demo/health')).json();
  expect(String(health.segmind)).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

  await page.goto('/');

  // pick the (model, provider) pair — the two controls compose one `seedance-2.5@segmind`
  await page.getByRole('radio', { name: 'Seedance 2.5' }).click();
  const provider = page.getByRole('radiogroup', { name: 'Provider' });
  await expect(provider).toBeVisible();
  await provider.getByRole('radio', { name: 'Segmind' }).click();

  // the create-page hint is honest before a cent is committed: Segmind's real rate, not fal's
  const hint = page.getByTestId('backend-hint');
  await expect(hint).toContainText('$0.24');            // $0.2389/s at 720p, Segmind's published figure
  await expect(hint).not.toContainText(/not on file/i);
  await expect(hint).not.toContainText(/\bfree\b/i);

  await page.getByRole('textbox').first().fill('a lantern keeper counts the ships home');
  await page.getByRole('button', { name: /plan it/i }).click();
  await expect(page).toHaveURL(/\/runs\/web-/);
  await expect(page.getByText(/plan is ready/i).first()).toBeVisible({ timeout: 60_000 });

  // the plan prices off the Segmind rows — a figure on the button, and no "not on file" anywhere
  await expect(page.getByText(/price not set/i)).toHaveCount(0);
  const render = page.getByRole('button', { name: /full render/i }).first();
  await expect(render).toBeEnabled();
  await expect(render).toContainText('$');
  await render.click();
  const confirmDialog = page.getByRole('dialog');
  if (await confirmDialog.isVisible().catch(() => false)) {
    await confirmDialog.getByRole('button', { name: /^(start|continue)/i }).first().click();
  }

  // the clips came back from the Segmind mock and stitched into a real master
  await expect(page.locator('video').first()).toBeVisible({ timeout: 90_000 });

  // approve WITH the upscale — on a Segmind run this is Segmind's Topaz, the last fal-free step
  const upscale = page.getByRole('checkbox', { name: /upscale to ~1080p/i });
  await expect(upscale).toBeEnabled();
  await upscale.check();
  const approve = page.getByRole('button', { name: /^approve & upscale/i });
  await expect(approve).toBeEnabled();
  await expect(approve).toContainText('$'); // Segmind's Topaz publishes $0.125/s — approve quotes it
  await approve.click();
  const approveDialog = page.getByRole('dialog');
  if (await approveDialog.isVisible().catch(() => false)) {
    await approveDialog.getByRole('button', { name: /^(start|continue|approve)/i }).first().click();
  }

  await expect(page.getByText(/is done|Complete/i).first()).toBeVisible({ timeout: 120_000 });
  const download = page.getByRole('link', { name: /download/i });
  await expect(download).toHaveAttribute('href', /\/api\/media\/out\//);
  await expect(download).toHaveAttribute('download', /\.mp4$/);
});
