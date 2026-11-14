/** Chrome Prompt API: https://developer.chrome.com/docs/ai/prompt-api
 * Only an already available model may be used: never start a download automatically. */
export async function browserTitle(text:string):Promise<string|undefined> {
 const api=(globalThis as unknown as {LanguageModel?:{availability():Promise<string>;create(options?:{signal:AbortSignal}):Promise<{prompt(s:string,options?:{signal:AbortSignal}):Promise<string>;destroy():void}>}}).LanguageModel;
 if(!api)return;
 try {
  if(await api.availability()!=='available')return;
  const signal=AbortSignal.timeout(1500);
  const session=await api.create({signal});
  try{return (await session.prompt('Give only a 3 to 5 word chat title, no quotes, for this message: '+text.slice(0,600),{signal})).trim().replace(/^["']|["']$/g,'').slice(0,42)||undefined;}
  finally{session.destroy();}
 }catch{return;}
}
