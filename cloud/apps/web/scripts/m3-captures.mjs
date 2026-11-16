import {chromium} from '@playwright/test';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
const dir=process.env.CAPTURE_DIR,base='http://127.0.0.1:5263';await mkdir(dir,{recursive:true});
const browser=await chromium.launch(),context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage(),metrics=[];
try{
 await page.request.post(base+'/v1/auth/dev',{data:{type:'auth.dev',userId:'m3-'+Date.now()}});await page.goto(base);await page.getByTestId('composer-input').waitFor();
 for(const count of (process.env.ONLY_TITLES?[]:[1,3,30])){
  const existing=(await page.request.get(base+'/v1/saved-values').then(r=>r.json())).items;
  for(let i=existing.length;i<count;i++){const r=await page.request.post(base+'/v1/saved-values',{data:{kind:'variable',name:i===0?'database_url':'saved_value_'+i,value:'synthetic example'}});if(!r.ok())throw new Error(await r.text());}
  await page.goto(base+'/settings/saved-values');const box=page.getByTestId('saved-values-box');await box.getByText('database_url',{exact:true}).waitFor();await page.waitForTimeout(500);
  for(const theme of ['light','dark']){
   await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.waitForTimeout(200);
   metrics.push({count,theme,...await box.evaluate(el=>{const b=el.getBoundingClientRect(),r=el.querySelector('[data-testid^="saved-value-"]').getBoundingClientRect(),s=getComputedStyle(el);return {height:b.height,rowHeight:r.height,scrollHeight:el.scrollHeight,rows:el.querySelectorAll('[data-testid^="saved-value-"]').length,padding:[s.paddingTop,s.paddingRight,s.paddingBottom,s.paddingLeft]};})});await page.screenshot({path:`${dir}/values-${count}-${theme}.png`});
  }
  if(count===30){await box.evaluate(el=>el.scrollTop=el.scrollHeight);await page.getByText('database_url',{exact:true}).waitFor();}
 }
 const inputs=['say something then execute a tool then say something and then execute a tool then say something','write something semi long','write omething semi long'];
 const real=JSON.parse(await readFile(process.env.HOME+'/.praxis-agent-state/cloud/wp/M-fixtures/real-chats.json','utf8'));
 const titles=process.env.PHASE==='before'?['Hello\nHello\nHello','Integrating IoT Systems','Here are a few options:\n\n* Chat: Longer Re']:['','',''];
 for(let i=0;i<3;i++){
  const chat=await page.request.post(base+'/v1/chats',{data:{type:'chat.input',...(titles[i]?{title:titles[i]}:{})}}).then(r=>r.json());if(process.env.PHASE!=='before')await page.request.post(base+'/v1/runs',{data:{type:'run.start',chatId:chat.id,text:inputs[i]}});
  const now=new Date().toISOString();
  await page.route('**/v1/chats/'+chat.id+'/messages*',route=>route.fulfill({json:{items:real[[2,1,0][i]].messages.map((m,j)=>({...m,type:'message',id:`m3-${i}-${j}`,chatId:chat.id,createdAt:now,updatedAt:now,parts:j===0?[{type:'text',text:inputs[i]}]:m.parts})),nextCursor:null}}));
  await page.goto(base+'/c/'+chat.id);await page.getByTestId('nav-chat-title-pill').waitFor();await page.waitForTimeout(400);metrics.push({title:await page.getByTestId('nav-chat-title-pill').innerText()});await page.screenshot({path:`${dir}/title-${i+1}.png`});
 }
 await writeFile(dir+(process.env.ONLY_TITLES?'/title-measurements.json':'/measurements.json'),JSON.stringify(metrics,null,2));
}finally{await context.close();await browser.close();}
