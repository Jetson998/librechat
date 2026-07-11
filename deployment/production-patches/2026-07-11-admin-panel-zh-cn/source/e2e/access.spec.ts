import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

function uniqueName(prefix: string) {
  return `${prefix} ${Date.now()}`;
}

async function hideTanStackDevtools(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    document
      .querySelector<HTMLElement>('button[aria-label="Open TanStack Devtools"]')
      ?.style.setProperty('display', 'none');
  });
}

test.describe('Access page accessibility', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/access');
    await page.waitForLoadState('networkidle');
  });

  test('has zero WCAG 2.1 AA violations on Groups tab', async ({ page }) => {
    await page.getByRole('tab', { name: /groups/i }).click();
    await expect(page.getByText('Engineering', { exact: true })).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();

    expect(results.violations).toEqual([]);
  });

  test('has zero WCAG 2.1 AA violations on Roles tab', async ({ page }) => {
    await expect(page.getByText('Admin', { exact: true })).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();

    expect(results.violations).toEqual([]);
  });
});

test.describe('Access page tabs', () => {
  test('defaults to Roles tab', async ({ page }) => {
    await page.goto('/access');
    await page.waitForLoadState('networkidle');

    await expect(page.getByText('Billing', { exact: true })).toBeVisible();
  });

  test('switches to Groups tab and updates URL', async ({ page }) => {
    await page.goto('/access');
    await page.waitForLoadState('networkidle');

    await page.getByRole('tab', { name: /groups/i }).click();

    await expect(page.getByText('Engineering', { exact: true })).toBeVisible();
    expect(page.url()).toContain('tab=groups');
  });

  test('respects ?tab=roles in URL', async ({ page }) => {
    await page.goto('/access?tab=roles');
    await page.waitForLoadState('networkidle');

    await expect(page.getByText('Admin', { exact: true })).toBeVisible();
    await expect(page.getByText('Billing', { exact: true })).toBeVisible();
  });

  test('switches back to Groups from Roles', async ({ page }) => {
    await page.goto('/access?tab=roles');
    await page.waitForLoadState('networkidle');

    await page.getByRole('tab', { name: /groups/i }).click();

    await expect(page.getByText('Engineering', { exact: true })).toBeVisible();
    expect(page.url()).toContain('tab=groups');
  });
});

test.describe('Access page search', () => {
  test('filters groups by name', async ({ page }) => {
    await page.goto('/access?tab=groups');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('Engineering', { exact: true })).toBeVisible();

    await page.getByRole('searchbox').fill('marketing');

    await expect(page.getByText('Marketing', { exact: true })).toBeVisible();
    await expect(page.getByText('Engineering', { exact: true })).not.toBeVisible();
  });

  test('filters roles by name', async ({ page }) => {
    await page.goto('/access?tab=roles');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('Admin', { exact: true })).toBeVisible();

    await page.getByRole('searchbox').fill('billing');

    await expect(page.getByText('Billing', { exact: true })).toBeVisible();
    await expect(page.getByText('Admin', { exact: true })).not.toBeVisible();
  });

  test('shows empty state when no groups match', async ({ page }) => {
    await page.goto('/access?tab=groups');
    await page.waitForLoadState('networkidle');

    await page.getByRole('searchbox').fill('zzzznonexistent');

    await expect(page.getByText(/no groups found/i)).toBeVisible();
  });
});

test.describe('Access page Create Group dialog', () => {
  test('creates a new group and shows it in the list', async ({ page }) => {
    const name = uniqueName('E2E Group');
    await page.goto('/access?tab=groups');
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: /create group/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.locator('#create-group-name').fill(name);
    await page.locator('#create-group-description').fill('Created by e2e test');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /create group/i })
      .click();

    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByText(name)).toBeVisible({ timeout: 5000 });
  });

  test('Create Group button is disabled when name is empty', async ({ page }) => {
    await page.goto('/access?tab=groups');
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: /create group/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    const createBtn = page.getByRole('dialog').getByRole('button', { name: /create group/i });
    await expect(createBtn).toBeDisabled();
  });
});

test.describe('Access page Create Role dialog', () => {
  test('creates a new role and shows it in the list', async ({ page }) => {
    const name = uniqueName('E2E Role');
    await page.goto('/access?tab=roles');
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: /create role/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.locator('#create-role-name').fill(name);
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /create role/i })
      .click();

    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByText(name)).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Access page Members dialog', () => {
  test('opens members dialog by clicking a group name', async ({ page }) => {
    await page.goto('/access?tab=groups');
    await page.waitForLoadState('networkidle');

    await page.getByText('Engineering', { exact: true }).click();

    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Alice Chen')).toBeVisible();
    await expect(page.getByText('Bob Martinez')).toBeVisible();
  });

  test('opens members dialog via kebab menu', async ({ page }) => {
    await page.goto('/access?tab=groups');
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: /actions engineering/i }).click();
    await page.getByText(/manage members/i).click();

    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });
  });

  test('shows member count', async ({ page }) => {
    await page.goto('/access?tab=groups');
    await page.waitForLoadState('networkidle');

    await page.getByText('Engineering', { exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });

    await expect(page.getByText(/4 members/i)).toBeVisible();
  });
});

test.describe('Access page system role protection', () => {
  test('system roles show System badge', async ({ page }) => {
    await page.goto('/access?tab=roles');
    await page.waitForLoadState('networkidle');

    await expect(page.getByText('System').first()).toBeVisible();
  });

  test('system role kebab menu has no delete option', async ({ page }) => {
    await page.goto('/access?tab=roles');
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: /actions admin$/i }).click();

    await expect(page.getByText(/manage members/i)).toBeVisible();
    await expect(page.getByText(/delete/i)).not.toBeVisible();
  });
});

test.describe('Access page keyboard reorder', () => {
  test('focus returns to the moved item after drop', async ({ page }) => {
    await page.goto('/access?tab=roles');
    await page.waitForLoadState('networkidle');

    const firstItem = page.locator('[data-item-id]').first();
    const firstName = await firstItem.locator('span').first().textContent();

    await firstItem.focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');

    const focused = page.locator(`[data-item-id] :focus, [data-item-id]:focus`);
    await expect(focused).toContainText(firstName!, { timeout: 5000 });
  });
});

test.describe('Access page delete', () => {
  test('deletes a non-system role via kebab menu', async ({ page }) => {
    const name = uniqueName('Deletable Role');
    await page.goto('/access?tab=roles');
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: /create role/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.locator('#create-role-name').fill(name);
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /create role/i })
      .click();
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByText(name)).toBeVisible({ timeout: 5000 });

    // New role is appended at the bottom where TanStack Devtools can overlap
    await hideTanStackDevtools(page);
    const kebabName = new RegExp(`actions ${name}`, 'i');
    await page.getByRole('button', { name: kebabName }).click();
    await page.getByText(/delete/i).click();

    const confirmDialog = page.getByRole('dialog');
    await expect(confirmDialog.getByText(/are you sure/i)).toBeVisible();
    await confirmDialog.getByRole('button', { name: /delete/i }).click();

    await expect(confirmDialog).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByText(name)).not.toBeVisible({ timeout: 5000 });
  });
});
