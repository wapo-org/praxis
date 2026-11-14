import {chromium} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
const dir=process.env.CAPTURE_DIR,browser=await chromium.launch();
try {
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 await page.request.post('http://127.0.0.1:5251/v1/auth/dev',{data:{type:'auth.dev',userId:'k1-title-capture'}});
 await page.goto('http://127.0.0.1:5251/');
 await page.getByTestId('composer-input').waitFor();
 await page.getByTestId('composer-input').fill('Plan a short Lisbon trip');
 const response=page.waitForResponse(r=>r.url().endsWith('/v1/runs')&&r.request().method()==='POST');
 await page.getByTestId('composer-send-button').click();
 await response;
 await page.screenshot({path:dir+'/title-crossfade-start.png'});
 await page.waitForTimeout(100);
 await page.screenshot({path:dir+'/title-crossfade-100ms.png'});
 await page.waitForTimeout(400);
 await page.screenshot({path:dir+'/title-crossfade-rest.png'});
 const title=await page.getByTestId('nav-chat-title-pill').innerText();
 await writeFile(dir+'/title-crossfade.json',JSON.stringify({title,source:'live scripted provider title completion; actual app header and sidebar'},null,2));
}finally{await browser.close();}
