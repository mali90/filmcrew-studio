// Characters, end to end and zero-spend: create a profile → add a reference image → the Cast
// page shows a character-first card → star them in an idea on Home → the plan records the cast.
import { test, expect } from '@playwright/test';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

test.beforeEach(async ({ request }) => {
  await request.post('/__demo/env-reset', { data: { complete: true } });
});

test('create a character → link a reference → star them in an idea → the plan is built around them', async ({ page, request }) => {
  // unique per run — the demo cast workspace persists across local e2e invocations
  const name = `Keeper ${Date.now().toString(36)}`;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  // create the profile through the editor route
  await page.goto('/cast');
  await page.getByRole('link', { name: /new character/i }).first().click();
  await expect(page).toHaveURL(/\/cast\/new/);
  await page.getByLabel(/name/i).fill(name);
  await page.getByRole('button', { name: /insert template/i }).click();
  await page.getByRole('button', { name: /create character/i }).click();
  await expect(page).toHaveURL(new RegExp(`/cast/${slug}`));

  // upload a reference from the character editor — auto-named <slug>-01.png and linked
  await page.locator('input[type=file][accept*="image"]').setInputFiles({
    name: 'face.png', mimeType: 'image/png', buffer: PNG,
  });
  await expect(page.locator(`img[src*="${slug}-01"]`).first()).toBeVisible();

  // the Cast page shows the character card, complete with its ref count
  await page.getByRole('link', { name: 'Cast', exact: true }).first().click();
  await expect(page).toHaveURL(/\/cast$/);
  const card = page.locator('article', { hasText: name });
  await expect(card).toBeVisible();
  await expect(card.getByText(/1 ref/)).toBeVisible();

  // star them in an idea on Home — the picker only exists because a character does
  await page.goto('/');
  const starring = page.getByRole('group', { name: 'Starring' });
  await expect(starring).toBeVisible();
  await starring.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.getByText(/their profile, reference images and voice will guide the plan/i)).toBeVisible();

  await page.getByRole('textbox').first().fill('the keeper tends the lamp one last time');
  await page.getByRole('button', { name: /plan it/i }).click();
  await expect(page).toHaveURL(/\/runs\/web-/);
  const runId = page.url().match(/\/runs\/(web-[^/?#]+)/)![1];

  // the plan completes and the run carries the starred cast all the way to the spec
  await expect(page.getByText(/plan is ready/i).first()).toBeVisible({ timeout: 60_000 });
  const run = await (await request.get(`/api/runs/${runId}`)).json();
  expect(run.run.manifest.cast).toEqual([slug]);
  expect(run.run.spec.cast).toEqual([slug]);
});
