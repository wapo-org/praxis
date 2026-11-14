import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chromium} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const origin='http://127.0.0.1:5251';
let api,web,browser;
async function stop(child){if(child&&child.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}}
async function startApi(){
 const child=spawn(process.execPath,['node_modules/tsx/dist/cli.mjs','apps/api/src/local.ts'],{env:{...process.env,PORT:'8881',PRAXIS_EMBEDDER:'hash',PRAXIS_ALLOWED_ORIGINS:origin},stdio:['ignore','pipe','pipe']});
 child.stdout.resume();child.stderr.resume();
 for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:8881/health')).ok)return child;}catch{}await new Promise(r=>setTimeout(r,100));}
 await stop(child);throw new Error('API did not start');
}
try{
 api=await startApi();
 web=spawn(process.execPath,['../../node_modules/vite/bin/vite.js','--port','5251','--strictPort','--host','127.0.0.1'],{cwd:'apps/web',env:{...process.env,VITE_API_PROXY_TARGET:'http://127.0.0.1:8881'},stdio:['ignore','pipe','pipe']});
 web.stdout.resume();web.stderr.resume();
 for(let i=0;i<100;i++){try{if((await fetch(origin)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch();const page=await browser.newPage({viewport:{width:1440,height:900}});
 await page.goto(origin);
 await page.getByRole('button',{name:'Continue as local dev user'}).waitFor();
 await page.getByRole('button',{name:'Continue as local dev user'}).click();
 await page.getByTestId('composer-input').fill('Plan a short Lisbon trip');
 await page.getByTestId('composer-send-button').click();
 await page.getByTestId('assistant-turn').first().waitFor();
 await stop(api);api=await startApi();
 const failed=page.waitForResponse(r=>r.url().endsWith('/v1/runs')&&r.status()===404);
 await page.getByTestId('composer-input').fill('Continue the trip');
 await page.getByTestId('composer-send-button').click();
 const response=await (await failed).json();
 assert.equal(response.code,'chat_missing');
 await page.getByText(/This chat or its model is no longer available after the server restarted/).waitFor();
 await page.screenshot({path:process.env.CAPTURE_DIR+'/run-error-line.png'});
 await writeFile(process.env.CAPTURE_DIR+'/restart-proof.json',JSON.stringify({status:404,code:response.code,cause:'The live client retained the chat id while an actual API process restart erased its in-memory chat record.'},null,2));
 console.log('PASS: actual in-memory API process restart under a live client; chat_missing 404; actionable error line');
}finally{await browser?.close();await stop(web);await stop(api);}
