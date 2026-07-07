// The money path, end to end and zero-spend: idea → live 8-agent planning → full render (priced,
// first-paid confirm; the single-job plan offers NO probe) → review → change request through the
// engine → scoped re-render → approve → final file on disk.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/__demo/env-reset', { data: { complete: true } });
  await request.post('/__demo/fal-opts', { data: { validationFail: false, authFail: false } });
});

test('idea → plan → render → review → revise → re-render → approve → complete', async ({ page }) => {
  await page.goto('/');

  // create
  await page.getByRole('textbox').first().fill('a tiny robot waters a rooftop garden at sunrise');
  await page.getByRole('button', { name: /plan it/i }).click();
  await expect(page).toHaveURL(/\/runs\/web-/);

  // the 8-agent hero: agent names appear, then the plan completes
  await expect(page.getByText('Showrunner', { exact: true })).toBeVisible();
  await expect(page.getByText(/plan is ready/i).first()).toBeVisible({ timeout: 60_000 });

  // a single-job plan offers no probe — it would be the full render at the same price
  await expect(page.getByRole('button', { name: /^probe/i })).toHaveCount(0);

  // the full render carries a price; the first paid click asks once
  const render = page.getByRole('button', { name: /full render/i }).first();
  await expect(render).toContainText('$');
  await render.click();
  const confirmDialog = page.getByRole('dialog');
  if (await confirmDialog.isVisible().catch(() => false)) {
    await confirmDialog.getByRole('button', { name: /^(start|continue)/i }).first().click();
  }

  // stitch precedes review: the player appears with a real master
  await expect(page.locator('video').first()).toBeVisible({ timeout: 90_000 });

  // change request goes through the engine
  await page.getByRole('textbox').last().fill('make the sunrise warmer');
  await page.getByRole('button', { name: /send to the engine/i }).click();
  await expect(page.getByText(/Showrunner|Scene Director/i).first()).toBeVisible({ timeout: 30_000 });

  // after the revision lands, a re-render CTA appears; take it
  const rerender = page.getByRole('button', { name: /re-render/i }).first();
  await expect(rerender).toBeVisible({ timeout: 60_000 });
  await rerender.click();
  await expect(page.locator('video').first()).toBeVisible({ timeout: 90_000 });

  // approve without upscale → complete, with a real same-origin Download link to the final file
  await page.getByRole('button', { name: /^approve/i }).click();
  await expect(page.getByText(/is done|Complete/i).first()).toBeVisible({ timeout: 30_000 });
  const download = page.getByRole('link', { name: /download/i });
  await expect(download).toBeVisible();
  await expect(download).toHaveAttribute('href', /\/api\/media\/out\//);
  await expect(download).toHaveAttribute('download', /\.mp4$/);

  // the finished run is findable in the Library and clicks back to its page
  await page.getByRole('link', { name: 'Library', exact: true }).click();
  await expect(page).toHaveURL(/\/library$/);
  const card = page.getByRole('region', { name: 'Run library' }).getByRole('link', { name: /Ocean Lighthouse/i }).first(); // the fake LLM titles every plan Ocean Lighthouse
  await expect(card).toBeVisible();
  await card.click();
  await expect(page).toHaveURL(/\/runs\/web-/);
});
