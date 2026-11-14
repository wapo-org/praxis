import {chromium,webkit} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
const dir=process.env.CAPTURE_DIR;
await mkdir(dir,{recursive:true});
for(const [name,engine] of Object.entries({chromium,webkit})){
 const browser=await engine.launch();
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  await page.request.post('http://127.0.0.1:5251/v1/auth/dev',{data:{type:'auth.dev',userId:'k1-captures'}});
  await page.goto('http://127.0.0.1:5251/lab/glass?morph');
  await page.getByTestId('morph-lab').waitFor();
  await page.getByTestId('nested-cascade').click();
  await page.waitForTimeout(1000);
  const parent=page.getByRole('menu').first();
  await parent.evaluate(el=>{window.__k1Parent=el;window.__k1Copy=el.querySelector('[data-dropdown-item-id]');});
  await parent.getByText('Save as',{exact:true}).click();
  await page.screenshot({path:dir+'/'+name+'-cascade-frame1.png'});
  await page.waitForTimeout(150);
  await page.screenshot({path:dir+'/'+name+'-cascade-frame150.png'});
  await page.waitForTimeout(1000);
  await page.screenshot({path:dir+'/'+name+'-cascade-rest.png'});
  await writeFile(dir+'/'+name+'-parent-stability.json',JSON.stringify(await page.evaluate(()=>({parentMounted:window.__k1Parent?.isConnected,copyMounted:window.__k1Copy?.isConnected})),null,2));
  await page.goto('http://127.0.0.1:5251/lab/glass?dropdown');
  await page.getByTestId('position-middle-end').click();
  await page.waitForTimeout(1000);
  await page.getByRole('menuitem',{name:'Scan',exact:true}).hover();
  await page.screenshot({path:dir+'/'+name+'-grid-hover.png'});
  await page.getByRole('menuitem',{name:'Delete',exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:dir+'/'+name+'-last-item.png'});

 }finally{await browser.close();}
}
