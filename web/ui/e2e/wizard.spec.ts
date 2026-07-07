// First-run wizard against the isolated demo env root — the repo's real .env is never touched.
import { test, expect } from '@playwright/test';

test('fresh install → wizard takeover → configure → land on Home', async ({ page, request }) => {
  await request.post('/__demo/env-reset', { data: { complete: false } });
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup/);

  // welcome
  await page.getByRole('button', { name: /set up/i }).click();

  // LLM: pick the CLI transport (no key needed — validated later by the health check)
  await page.getByRole('radio', { name: /^Claude/ }).click();
  await page.getByRole('radio', { name: 'Local CLI' }).click();
  await page.getByRole('button', { name: /continue|next/i }).click();

  // fal key: validate against the mock, then continue
  await page.getByLabel(/fal/i).first().fill('demo-key-123');
  await page.getByRole('button', { name: /validate/i }).click();
  await expect(page.getByText(/key valid/i)).toBeVisible();
  await page.getByRole('button', { name: /continue|next/i }).click();

  // backend + presets: accept defaults
  await page.getByRole('button', { name: /continue|next/i }).click();
  await page.getByRole('button', { name: /continue|next/i }).click();

  // save .env: the masked diff renders, then write
  await expect(page.getByText(/FAL_KEY/i)).toBeVisible();
  await page.getByRole('button', { name: /write \.env/i }).click();

  // doctor, then done
  await page.getByRole('button', { name: /continue|next|finish/i }).click();
  await page.getByRole('button', { name: /create your first video/i }).click();
  await expect(page).toHaveURL(/\/$/);
});

test.afterEach(async ({ request }) => {
  await request.post('/__demo/env-reset', { data: { complete: true } });
});
