// Aspect honesty, whole pipeline: a 16:9 run's stitched master must BE landscape (the stitch
// canvas once center-cropped everything into a fixed 9:16), and the review player box follows.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/__demo/env-reset', { data: { complete: true } });
});

test('a 16:9 run reviews as landscape — master file and player box alike', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('textbox').first().fill('a wide horizon, aspect regression');
  await page.getByRole('radio', { name: /16:9/ }).click();
  await page.getByRole('button', { name: /plan it/i }).click();
  await expect(page).toHaveURL(/\/runs\/web-/);
  await expect(page.getByText(/plan is ready/i).first()).toBeVisible({ timeout: 60_000 });

  const render = page.getByRole('button', { name: /full render/i }).first();
  await render.click();
  const dialog = page.getByRole('dialog');
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.getByRole('button', { name: /^(start|continue)/i }).first().click();
  }
  const master = page.getByTestId('master-video');
  await expect(master).toBeVisible({ timeout: 90_000 });
  // wait for metadata so the box reflects the file's intrinsic ratio
  await expect
    .poll(async () => master.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 15_000 })
    .toBeGreaterThan(0);

  const dims = await master.evaluate((v: HTMLVideoElement) => ({ w: v.videoWidth, h: v.videoHeight }));
  expect(dims.w).toBeGreaterThan(dims.h); // the FILE is landscape (stitch canvas followed the aspect)

  const box = await master.boundingBox();
  expect(box!.width).toBeGreaterThan(box!.height); // and so is the player
});
