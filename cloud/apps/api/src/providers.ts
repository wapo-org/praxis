import {probeProvider} from './provider-probe.js';
import {createHTTPProvider,type HTTPProvider} from '@praxis/agent';
import type {Model,Provider} from '@praxis/protocol';
import type {ApiService} from './service.js';
import {ApiError} from './service.js';
import {unseal} from './secrets.js';
/** Secret-bearing HTTP providers are reconstructed per execution slice, never checkpointed. */
export class ApiProviders{
 constructor(private service:ApiService,private key:string|undefined,private fetcher:typeof fetch=fetch){}
 async resolve(userId:string,providerId:string):Promise<{profile:Provider;provider:HTTPProvider}>{
  const profile=await this.service.require<Provider>(userId,'provider',providerId);const encrypted=await this.service.adapters.store.get(userId,'providerSecret',providerId);
  let apiKey='',extraHeaders:Record<string,string>={};
  if(encrypted?.value.apiKey||encrypted?.value.extraHeaders){if(!this.key)throw new ApiError(503,'encryption_unconfigured','Secret storage is not configured');try{if(typeof encrypted.value.apiKey==='string')apiKey=unseal(encrypted.value.apiKey,userId,`provider:${providerId}:key`,this.key);if(typeof encrypted.value.extraHeaders==='string')extraHeaders=JSON.parse(unseal(encrypted.value.extraHeaders,userId,`provider:${providerId}:headers`,this.key));}catch{throw new ApiError(503,'secret_unavailable','Provider credentials could not be read');}}
  return {profile,provider:createHTTPProvider({flavor:profile.flavor,baseUrl:profile.baseUrl,apiKey,providerId,capabilities:profile.capabilities,extraHeaders,...profile.requestOptions},this.fetcher)};
 }
 async requireConsent(userId:string,providerId:string){const profile=await this.service.require<Provider>(userId,'provider',providerId);const host=new URL(profile.baseUrl).host.toLowerCase();const consent=await this.service.adapters.store.get(userId,'consent',host);if(consent?.value.allowed!==true)throw new ApiError(403,'consent_required',`Allow sharing AI data with ${host} before starting this run`);}
 async probe(userId:string,providerId:string,modelId:string){
  const {provider}=await this.resolve(userId,providerId);
  const model=await this.service.require<Model>(userId,'model',`${providerId}:${modelId}`);
  const {probe,learning}=await probeProvider(provider,model);
  const key=`${providerId}:${modelId}`,row=await this.service.adapters.store.get(userId,'modelLearning',key);
  const next={...(row&&!row.deleted?row.value:{}),...learning};
  // Successful explicit probes clear old negative observations.
  if(probe.tools)delete next.tools;if(probe.vision)delete next.images;
  if(model.capabilities.reasoningEffort)next.efforts={levels:probe.reasoningEfforts,at:Date.now()};
  await this.service.adapters.store.put(userId,'modelLearning',key,next);
  return {type:'provider.test.result',ok:probe.streaming,models:[model],probe};
 }
 async refresh(userId:string,providerId:string){const {provider}=await this.resolve(userId,providerId);const models=await provider.listModels();const old=await this.service.list<Model>(userId,'model');const next=new Set(models.map(m=>m.id));
  for(const m of models){const before=old.find(p=>p.providerId===providerId&&p.id===m.id);await this.service.write(userId,'model',`${providerId}:${m.id}`,{...m,pinned:before?.pinned??false,favorite:before?.favorite??false});}
  for(const m of old)if(m.providerId===providerId&&!next.has(m.id))await this.service.remove(userId,'model',`${providerId}:${m.id}`);
  // A fresh model list supersedes rejections learned from the provider (ProviderSettings.store clears them too).
  for(const r of await this.service.adapters.store.list(userId,'modelLearning'))if(r.id.startsWith(`${providerId}:`))await this.service.adapters.store.delete(userId,'modelLearning',r.id);
  await this.service.adapters.kv.set(`models:${userId}:${providerId}`,models,300);return models;
 }
}
