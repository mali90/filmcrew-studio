// The probe journey in the composed app: a MULTI-JOB plan (the fake LLM's TWO-JOB brief marker
// splits the golden plan into K1+K2) offers a priced Probe button next to Full render; clicking it
// renders only the first job and auto-assembles straight into review. This is the positive twin of
// money-path's "no Probe on a single-job plan" assertion — together they prove the button is
// gated, not merely gone.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/__demo/env-reset', { data: { complete: true } });
  await request.post('/__demo/fal-opts', { data: { validationFail: false, authFail: false } });
});

test('a multi-job plan offers a priced probe → first job renders → review', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('textbox').first().fill('a two act robot story TWO-JOB');
  await page.getByRole('button', { name: /plan it/i }).click();
  await expect(page).toHaveURL(/\/runs\/web-/);
  await expect(page.getByText(/plan is ready/i).first()).toBeVisible({ timeout: 60_000 });

  // both money buttons exist and carry prices; the probe is the guided (primary) first step
  const probe = page.getByRole('button', { name: /^probe/i }).first();
  const full = page.getByRole('button', { name: /full render/i }).first();
  await expect(probe).toContainText('$');
  await expect(full).toContainText('$');

  await probe.click();
  const confirmDialog = page.getByRole('dialog');
  if (await confirmDialog.isVisible().catch(() => false)) {
    await confirmDialog.getByRole('button', { name: /^(start|continue)/i }).first().click();
  }

  // stitch precedes review: the probe's single clip auto-assembles into a playable master
  await expect(page.locator('video').first()).toBeVisible({ timeout: 90_000 });
});
