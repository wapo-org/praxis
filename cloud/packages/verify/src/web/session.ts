import type {Page} from '@playwright/test';

/** Local dev sign-in: every flow starts signed out in a fresh context. */
export async function signIn(page: Page, base: string): Promise<void> {
  await page.goto(base);
  await page.getByRole('button', {name: 'Continue as local dev user'}).click();
  await page.getByTestId('chat-top-bar').waitFor();
}
