import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
const dir=process.env.CAPTURE_DIR;if(!dir)throw new Error('CAPTURE_DIR required');await mkdir(dir,{recursive:true});
const browser=await chromium.launch();
try {
 const metrics=[];
 for(const theme of ['light','dark']){
  const context=await browser.newContext({viewport:{width:2288,height:2000},colorScheme:theme});
  const page=await context.newPage();await page.goto(`${process.env.BASE}/lab/activity`);
  await page.getByRole('button',{name:'Continue as local dev user'}).waitFor();await page.getByRole('button',{name:'Continue as local dev user'}).click();
  await page.getByTestId('typography-options').waitFor();await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;return document.fonts.ready;},theme);
  await page.getByTestId('typography-options').screenshot({path:`${dir}/typography-options-${theme}.png`});
  metrics.push(await page.getByTestId('typography-options').evaluate((el,theme)=>({theme,options:Array.from(el.querySelectorAll('[data-testid=agent-message-view]')).map(node=>{const s=getComputedStyle(node);const canvas=document.createElement('canvas');const ctx=canvas.getContext('2d');ctx.font=s.font;return {font:s.font,fontSize:s.fontSize,lineHeight:s.lineHeight,width:node.getBoundingClientRect().width,measureCh:node.getBoundingClientRect().width/ctx.measureText('0').width};})}),theme));
  await page.getByTestId('agent-activity-toggle').click();await page.getByTestId('tool-step-header-sample-1').click();
  await page.getByTestId('work-log-comparison').screenshot({path:`${dir}/work-log-source-comparison-${theme}.png`,animations:'disabled'});
  await context.close();
 }
 await writeFile(`${dir}/typography-metrics.json`,JSON.stringify(metrics,null,2));
} finally {await browser.close();}
