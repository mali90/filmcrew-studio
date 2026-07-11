// Environments, end to end and zero-spend: create an environment → the Cast page shows a text-only
// card → "Set in" that environment on Home → the plan records it on the manifest AND the spec.
// Mirrors cast.spec.ts. The demo's environments dir is isolated (starts empty), so — like the cast
// workspace — each run creates its own uniquely-named environment first.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post('/__demo/env-reset', { data: { complete: true } });
});

test('create an environment → set an idea in it → the plan is stamped with it', async ({ page, request }) => {
  // unique per run — the demo environments workspace persists across local e2e invocations
  const name = `Neon ${Date.now().toString(36)}`;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  // create the environment through the dedicated editor route
  await page.goto('/cast');
  await page.getByRole('link', { name: /new environment/i }).first().click();
  await expect(page).toHaveURL(/\/environments\/new/);
  await page.getByLabel(/name/i).fill(name);
  await page.getByRole('button', { name: /insert template/i }).click();
  await page.getByRole('button', { name: /create environment/i }).click();
  await expect(page).toHaveURL(new RegExp(`/environments/${slug}`));

  // the Cast page's Environments section shows the text-only card
  await page.getByRole('link', { name: 'Cast', exact: true }).first().click();
  await expect(page).toHaveURL(/\/cast$/);
  const card = page.locator('article', { hasText: name });
  await expect(card).toBeVisible();

  // set the idea IN that environment on Home — the "Set in" picker only exists because one does
  await page.goto('/');
  const setIn = page.getByRole('radiogroup', { name: 'Set in' });
  await expect(setIn).toBeVisible();
  await setIn.getByRole('radio', { name: new RegExp(name) }).click();
  // selecting the chip flips the helper caption from the "optional" prompt to the guiding one
  await expect(page.getByText(/its mood, light and palette will guide every shot/i)).toBeVisible();

  await page.getByRole('textbox').first().fill('a courier races the last train');
  await page.getByRole('button', { name: /plan it/i }).click();
  await expect(page).toHaveURL(/\/runs\/web-/);
  const runId = page.url().match(/\/runs\/(web-[^/?#]+)/)![1];

  // the plan completes and the run carries the environment all the way to the spec
  await expect(page.getByText(/plan is ready/i).first()).toBeVisible({ timeout: 60_000 });
  const run = await (await request.get(`/api/runs/${runId}`)).json();
  expect(run.run.manifest.environment).toBe(slug);
  expect(run.run.spec.environment).toBe(slug);
});
