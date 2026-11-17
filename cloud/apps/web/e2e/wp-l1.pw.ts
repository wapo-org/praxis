import { openSignedInPage, signedInTest as test } from './sign-in';
import {expect} from '@playwright/test';
test.beforeEach(async({page})=>{
 await openSignedInPage(page);
 await page.goto('/');await page.getByTestId('composer-input').waitFor();
});
test('regenerating the middle reply keeps one prompt, removes later turns, and survives reload',async({page})=>{
 for(const text of ['Closer','Later turn']){
  await page.getByTestId('composer-input').fill(text);await page.getByTestId('composer-send-button').click();await expect(page.getByTestId('assistant-turn').last()).toContainText('Scripted response: '+text);
 }
 await page.getByTestId('turn-retry-button').first().click();
 await expect(page.getByTestId('assistant-turn')).toHaveCount(1);await expect(page.getByTestId('assistant-turn')).toContainText('Scripted response: Closer');
 await page.reload();await expect(page.getByTestId('assistant-turn')).toHaveCount(1);await expect(page.getByTestId('assistant-turn')).toContainText('Scripted response: Closer');
 await expect(page.locator('body')).not.toContainText('Later turn');
});
for (const action of ['Submit', 'Decline', 'Cancel']) {
  test(`${action} removes the pending form before its response is released`, async ({page}) => {
    await page.getByTestId('composer-input').fill('Start elicitation');
    await page.getByTestId('composer-send-button').click();
    const form = page.getByTestId('elicitation-form-surface');
    await form.waitFor();
    if (action === 'Submit') await page.getByTestId('elicitation-input-name').fill('Ada');
    let release!: () => void;
    const pending = new Promise<void>(resolve => {release = resolve;});
    let entered!: () => void;
    const requested = new Promise<void>(resolve => {entered = resolve;});
    let responded = false;
    await page.route('**/v1/runs/*/elicitations', async route => {
      entered();
      await pending;
      await route.continue();
      responded = true;
    });
    try {
      await form.getByRole('button', {name: action, exact: true}).click();
      await requested;
      await expect(form).toHaveCount(0);
      expect(responded).toBe(false);
    } finally {
      release();
    }
  });
}
