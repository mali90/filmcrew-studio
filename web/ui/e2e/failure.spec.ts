// Failure honesty: a render that dies must surface a PERSISTENT error (survives reload — it lives
// in web.json, not in a toast), and recovery must re-render only what failed.
import { test, expect } from '@playwright/test';

test('render failure → persistent attention state across reload → retry succeeds', async ({ page, request }) => {
  await request.post('/__demo/env-reset', { data: { complete: true } });

  // plan a run
  await page.goto('/');
  await page.getByRole('textbox').first().fill('failure drill: a paper boat in a rainstorm');
  await page.getByRole('button', { name: /plan it/i }).click();
  await expect(page).toHaveURL(/\/runs\/web-/);
  await expect(page.getByText(/plan is ready|Full render/i).first()).toBeVisible({ timeout: 60_000 });

  // break fal, then render
  await request.post('/__demo/fal-opts', { data: { validationFail: true } });
  await page.getByRole('button', { name: /full render/i }).click();
  const confirmDialog = page.getByRole('dialog');
  if (await confirmDialog.isVisible().catch(() => false)) {
    await confirmDialog.getByRole('button', { name: /^(start|continue)/i }).first().click();
  }

  // the failure is a permanent surface, not a toast
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 60_000 });

  // …and it survives a full page reload (state derives from disk)
  await page.reload();
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 15_000 });

  // fix fal, retry → review
  await request.post('/__demo/fal-opts', { data: { validationFail: false } });
  await page.getByRole('button', { name: /retry|full render|render/i }).first().click();
  const confirm2 = page.getByRole('dialog');
  if (await confirm2.isVisible().catch(() => false)) {
    await confirm2.getByRole('button', { name: /^(start|continue)/i }).first().click();
  }
  await expect(page.locator('video').first()).toBeVisible({ timeout: 90_000 });
});
