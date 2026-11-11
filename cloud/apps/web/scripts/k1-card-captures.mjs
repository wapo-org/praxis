import {chromium} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
const dir=process.env.CAPTURE_DIR;await mkdir(dir,{recursive:true});
const browser=await chromium.launch();
try{
 const page=await browser.newPage({viewport:{width:1200,height:900}});
 await page.request.post('http://127.0.0.1:5251/v1/auth/dev',{data:{type:'auth.dev',userId:'k1-card-captures'}});
 await page.goto('http://127.0.0.1:5251/');
 await page.getByTestId('chat-top-bar').waitFor();
 await page.route('**/v1/saved-secrets',route=>route.fulfill({json:{items:[{id:'synthetic',name:'token',createdAt:'2026-11-11T00:00:00Z'}]}}));
 await page.evaluate(async()=>{
  const ReactModule=await import('/node_modules/.vite/deps/react.js'); const React=ReactModule.default??ReactModule;
  const Client=await import('/node_modules/.vite/deps/react-dom_client.js');const {createRoot}=Client.default??Client;
  const {ElicitationCards}=await import('/src/components/chat/ElicitationCards.tsx');
  const {ApprovalCards}=await import('/src/components/chat/ApprovalCards.tsx');
  const {SavedSecrets}=await import('/src/components/screens/SavedSecrets.tsx');
  document.getElementById('root').replaceChildren();
  const host=document.createElement('main');host.style.cssText='max-width:720px;margin:48px auto;display:grid;gap:24px';document.getElementById('root').append(host);
  function Fixture(){
   const [values,setValues]=React.useState({secret:{token:'synthetic value'}});
   return React.createElement(React.Fragment,null,
    React.createElement(ElicitationCards,{runId:'fixture',pendingElicitations:[{id:'secret',message:'Connect your account',schema:{type:'object',properties:{token:{type:'string',title:'API token',format:'password'}},required:['token']}}],elicitationValues:values,setElicitationValues:setValues,onResolveElicitation:async()=>{}}),
    React.createElement(ApprovalCards,{runId:'fixture',pendingApprovals:[{id:'approval',title:'Publish the report?',toolName:'publish',reason:'This shares the report with your team.',arguments:{document:'Quarterly report'},source:{type:'mcp',serverName:'Workspace'}}]}),
    React.createElement(SavedSecrets));
  }
  createRoot(host).render(React.createElement(Fixture));
 });
 await page.getByTestId('elicitation-input-token').waitFor();
 for(const theme of ['light','dark']){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  await page.waitForTimeout(400);
  await page.screenshot({path:dir+'/cards-'+theme+'-masked.png'});
  await page.getByRole('button',{name:'Reveal API token'}).click();
  await page.screenshot({path:dir+'/cards-'+theme+'-revealed.png'});
  await page.getByRole('button',{name:'Hide API token'}).click();
 }
}finally{await browser.close();}
