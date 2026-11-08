import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
const dir = `${process.env.HOME}/.praxis-agent-state/cloud/design/H/H1`;
await mkdir(dir, {recursive:true});
const browser = await chromium.launch();
try {
  for (const [width,height] of [[1440,900],[402,874]]) for (const theme of ['light','dark']) for (const mode of ['login','register']) {
    const context = await browser.newContext({viewport:{width,height},colorScheme:theme});
    const page = await context.newPage();
    await page.addInitScript(theme => {localStorage.setItem('praxis-theme',theme);},theme);
    await page.goto('http://127.0.0.1:5241');
    await page.getByRole('button',{name:'Continue as local dev user'}).waitFor();
    if (mode === 'register') await page.getByRole('button',{name:'Create an account',exact:true}).click();
    const name = `${dir}/${mode}-${theme}-${width}`;
    const button = page.getByRole('button',{name:mode === 'login' ? 'Sign in' : 'Create account',exact:true});
    await page.screenshot({path:`${name}-rest.png`,fullPage:true});
    await button.hover(); await page.screenshot({path:`${name}-hover.png`,fullPage:true});
    const box = await button.boundingBox(); await page.mouse.move(box.x+box.width/2,box.y+box.height/2); await page.mouse.down();
    await page.screenshot({path:`${name}-pressed.png`,fullPage:true}); await page.mouse.move(0,0); await page.mouse.up();
    await button.evaluate(el => el.disabled = true); await page.screenshot({path:`${name}-disabled.png`,fullPage:true}); await button.evaluate(el => el.disabled = false);
    await page.getByLabel('Email',{exact:true}).fill('fake@example.test'); await page.getByLabel('Password',{exact:true}).fill('fake-password-123');
    if (mode === 'register') { await button.click(); await page.getByLabel('Email code',{exact:true}).fill('123456'); }
    let release;
    await page.route('**/v1/auth/dev', async route => { await new Promise(resolve => {release=resolve;}); await route.continue(); });
    await page.getByRole('button',{name:mode === 'login' ? 'Sign in' : 'Verify and continue',exact:true}).click();
    await page.locator('button[disabled]').first().waitFor();
    await page.screenshot({path:`${name}-loading.png`,fullPage:true});
    release?.(); await context.close();
  }
  const page = await browser.newPage({viewport:{width:1000,height:400}});
  await page.goto('http://127.0.0.1:5241');
  await page.evaluate(async () => { const {mountReference} = await import('/src/auth/ClassicReference.tsx'); mountReference(); });
  await page.getByRole('heading',{name:'Radix Themes reference'}).waitFor();
  await page.screenshot({path:`dir` .replace('dir',dir)+'/classic-reference.png'});
} finally {await browser.close();}
