import assert from 'node:assert/strict';
const base=process.env.API_URL??`http://127.0.0.1:${process.env.PORT??8787}`;
const headers={Authorization:'Bearer dev-local','Content-Type':'application/json'};
async function json(path,body){const response=await fetch(`${base}${path}`,{headers,method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{})});assert(response.ok,`${path}: ${response.status}`);return response.json();}
const bootstrap=await json('/v1/bootstrap');assert.equal(bootstrap.type,'bootstrap');assert(bootstrap.models.length);
const chat=await json('/v1/chats',{type:'chat.input',title:'HTTP smoke'});
const run=await json('/v1/runs',{type:'run.start',chatId:chat.id,text:'Hello HTTP',clientTurnId:crypto.randomUUID()});
const events=await (await fetch(`${base}/v1/runs/${run.id}/events`,{headers})).text();assert(events.includes('run.finished'));assert(events.includes('Hello HTTP'));
const snapshot=await json(`/v1/runs/${run.id}/snapshot`);assert.equal(snapshot.run.status,'completed');assert(snapshot.blocks.some(b=>b.text.includes('Hello HTTP')));
const nested=await json('/v1/runs',{type:'run.start',chatId:chat.id,text:'Nested approval',script:'nestedApproval'});
let parked;for(let i=0;i<100;i++){parked=await json(`/v1/runs/${nested.id}/snapshot`);if(parked.pendingApprovals.length)break;await new Promise(r=>setTimeout(r,10));}assert(parked.pendingApprovals[0]?.parentCallId);
await json(`/v1/runs/${nested.id}/approvals`,{type:'approval.decision',approvalId:parked.pendingApprovals[0].id,decision:'allowOnce'});
assert((await (await fetch(`${base}/v1/runs/${nested.id}/events`,{headers})).text()).includes('run.finished'));
const long=await json('/v1/runs',{type:'run.start',chatId:chat.id,text:'Disconnect and cancel',script:'long'});
const stream=await fetch(`${base}/v1/runs/${long.id}/events`,{headers});const reader=stream.body.getReader();const first=await reader.read();assert(first.value.length);await reader.cancel();
await json(`/v1/runs/${long.id}/cancel`,{type:'run.cancel'});
const resumed=await (await fetch(`${base}/v1/runs/${long.id}/events`,{headers:{...headers,'Last-Event-ID':'1'}})).text();assert(resumed.includes('cancelled'));assert(!resumed.includes('id: 1\n'));
console.log(JSON.stringify({ok:true,base,checks:['bootstrap','chat','text SSE','snapshot','nested approval resume','disconnect','cancel','Last-Event-ID replay']}));
