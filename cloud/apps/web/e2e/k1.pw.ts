import { openSignedInPage, signedInTest as test } from './sign-in';
import {expect} from '@playwright/test';
test.beforeEach(async({page})=>{
 // Installed WebKit does not intercept these cross-origin fetches with route(); inject the same HTTP failure at fetch.
 await page.addInitScript(()=>{
  const original=window.fetch.bind(window);
  window.fetch=async(input,init)=>{
   const url=typeof input==='string'?input:input instanceof Request?input.url:String(input);
   if(url.endsWith('/elicitations')&&init?.method==='POST')return new Response(JSON.stringify({message:'Temporary fixture failure'}),{status:500,headers:{'content-type':'application/json'}});
   return original(input,init);
  };
 });
 await openSignedInPage(page);
 await page.goto('/');
 await page.getByTestId('composer-input').waitFor();
});
test('a streamed run failure offers a plain next step',async({page})=>{
 await page.getByTestId('composer-input').fill('Trigger an error');
 await page.getByTestId('composer-send-button').click();
 const error=page.getByTestId('chat-error-banner');
 await expect(error).toContainText(/try again/i);
 await expect(error).not.toContainText('/v1/runs');
});
test('a failed question submission keeps the answer and offers retry',async({page})=>{
 await page.getByTestId('composer-input').fill('Start an elicitation');
 await page.getByTestId('composer-send-button').click();
 await page.getByTestId('elicitation-input-name').fill('Test answer');
 await page.getByTestId('elicitation-submit').click();
 await expect(page.getByText('Could not send your answer. Try again.')).toBeVisible();
 await expect(page.getByTestId('elicitation-input-name')).toHaveValue('Test answer');
});
