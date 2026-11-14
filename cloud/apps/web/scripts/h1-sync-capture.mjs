import {chromium, expect} from '@playwright/test';
import sharp from 'sharp';
import {mkdir} from 'node:fs/promises';
const dir = `${process.env.HOME}/.praxis-agent-state/cloud/design/H/H1`;
await mkdir(dir,{recursive:true});
const browser = await chromium.launch();
try {
  const contexts = await Promise.all([browser.newContext({viewport:{width:1000,height:760}}),browser.newContext({viewport:{width:1000,height:760}})]);
  const pages = await Promise.all(contexts.map(c=>c.newPage()));
  for(const page of pages){await page.goto('http://127.0.0.1:5241');await page.getByRole('button',{name:'Continue as local dev user'}).waitFor();await page.getByRole('button',{name:'Continue as local dev user'}).click();await page.getByTestId('chat-top-bar').waitFor();}
  const chat = await pages[0].evaluate(async()=>{const {apiClient}=await import('/src/lib/api.ts');return apiClient.createChat({title:'Two devices · live sync'});});
  for(const page of pages){await page.goto(`http://127.0.0.1:5241/c/${chat.id}`);await page.getByTestId('composer-input').waitFor();}
  const rows=[];
  const capture = async(label)=>{
    const images=[];
    for(let i=0;i<2;i++){const path=`${dir}/sync-${label}-${i===0?'A':'B'}.png`;await pages[i].screenshot({path});images.push({input:path,left:i*1000,top:40});}
    const title=Buffer.from(`<svg width="2000" height="40"><rect width="2000" height="40" fill="#f4f1eb"/><text x="24" y="27" font-family="sans-serif" font-size="20">${label}: device A</text><text x="1024" y="27" font-family="sans-serif" font-size="20">device B (independent browser context)</text></svg>`);
    rows.push(await sharp({create:{width:2000,height:800,channels:3,background:'#f4f1eb'}}).composite([{input:title,left:0,top:0},...images]).png().toBuffer());
  };
  await capture('before');
  await pages[0].evaluate(async(chatId)=>{const {apiClient}=await import('/src/lib/api.ts');await apiClient.startRun({chatId,text:'Explain a careful plan, showing the response on both devices as it streams.',script:'long'});},chat.id);
  await pages[1].getByTestId('composer-stop-button').waitFor();
  await pages[1].getByTestId('chat-screen').getByText('Explain a careful plan, showing the response on both devices as it streams.',{exact:true}).waitFor();
  await pages[0].getByTestId('composer-stop-button').waitFor();
  await pages[0].getByTestId('assistant-turn').first().waitFor();
  await capture('live');
  await pages[1].getByTestId('composer-stop-button').click();
  await pages[0].getByTestId('composer-stop-button').waitFor({state:'hidden'});
  await pages[1].getByTestId('composer-stop-button').waitFor({state:'hidden'});
  await expect.poll(async () => (await pages[0].getByTestId('assistant-turn').allTextContents()).join('')).toBe((await pages[1].getByTestId('assistant-turn').allTextContents()).join(''));
  await capture('stopped-on-B');
  await sharp({create:{width:2000,height:2400,channels:3,background:'white'}}).composite(rows.map((input,i)=>({input,left:0,top:i*800}))).png().toFile(`${dir}/two-context-sync-strip.png`);
  await contexts[0].close();await contexts[1].close();
}finally{await browser.close();}
