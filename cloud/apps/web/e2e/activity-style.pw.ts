import {test,expect} from '@playwright/test';
test.beforeEach(async({page})=>{await page.goto('/lab/activity');await page.getByRole('button',{name:'Continue as local dev user'}).waitFor();await page.getByRole('button',{name:'Continue as local dev user'}).click();await page.getByTestId('work-log-comparison').waitFor();});
test('T3 group disclosure keeps its label before its chevron and uses relaxed 14px type',async({page})=>{
 const button=page.getByTestId('agent-activity-toggle');await expect(button).toHaveText('Worked for 4.2s');await expect(button).toHaveAttribute('aria-expanded','false');
 await expect(button).toHaveCSS('font-size','14px');await expect(button).toHaveCSS('line-height','22.75px');
 const positions=await button.evaluate(el=>({label:el.querySelector('span')!.getBoundingClientRect().right,chevron:el.querySelector('svg')!.getBoundingClientRect().left}));expect(positions.chevron).toBeGreaterThan(positions.label);
 await button.click();await expect(button).toHaveAttribute('aria-expanded','true');await expect(page.getByTestId('agent-activity-steps')).toBeVisible();
});
test('tool rows use type icons, mono commands and indented pre output instead of Details',async({page})=>{
 await page.getByTestId('agent-activity-toggle').click();
 const command=page.getByTestId('tool-step-header-sample-1');await expect(command.locator('[data-kind=command]')).toHaveCount(1);await expect(command).toContainText('npm run typecheck');expect(await command.innerText()).not.toContain('Details');
 await command.click();const detail=page.getByTestId('tool-step-detail-sample-1');await expect(detail).toHaveCSS('margin-inline-start','24px'); // 16 px icon + 8 px gap: the label's x (WP-J2)await expect(detail.locator('pre')).toContainText('All workspaces passed.');await expect(command).toHaveAttribute('aria-expanded','true');
});
test('question previews retain the answer and warnings remain inline',async({page})=>{
 await page.getByTestId('agent-activity-toggle').click();
 await expect(page.getByTestId('tool-step-header-sample-4')).toContainText('Asked “Which output format should I use?”');await expect(page.getByTestId('tool-step-header-sample-4')).toContainText('Markdown, with a short table.');await expect(page.getByRole('img',{name:'Tool call denied'})).toBeVisible();
 // WP-J2: the denial is a small status at the row's end; the row stays one line.
 const denied=page.getByTestId('tool-step-header-sample-5');await expect(denied.getByText('Denied',{exact:true})).toBeVisible();expect((await denied.boundingBox())!.height).toBeLessThan(34); // one line, never wrapped
});
test('reading option has a bounded measure and a real h1–h4 hierarchy',async({page})=>{
 const reading=page.getByTestId('typography-options').locator('article').nth(1).getByTestId('agent-message-view');await expect(reading).toHaveCSS('font-size','16px');await expect(reading).toHaveCSS('line-height','26px');for(const level of [1,2,3,4])await expect(reading.locator(`h${level}`)).toHaveCount(1);
 const width=await reading.evaluate(el=>el.getBoundingClientRect().width);expect(width).toBeLessThanOrEqual(720);await expect(reading.locator('blockquote')).toHaveCount(1);await expect(reading.locator('table')).toHaveCount(1);await expect(reading.locator('pre code')).toContainText('npm run typecheck');
});
