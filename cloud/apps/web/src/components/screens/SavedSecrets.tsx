import React from 'react';
import {apiClient, type SavedValue, PraxisApiError} from '../../lib/api';
import {Section,Card,Field,Select,ScreenButton,TaskError,useScreenTask} from './ScreenUI';
import styles from './Screen.module.css';
import saved from './SavedValues.module.css';

export function SavedValues() {
 const [items,setItems]=React.useState<SavedValue[]>([]);
 const [loaded,setLoaded]=React.useState(false);
 const [loadError,setLoadError]=React.useState('');
 const [name,setName]=React.useState(''),[value,setValue]=React.useState('');
 const [kind,setKind]=React.useState<'variable'|'secret'>('variable');
 const [format,setFormat]=React.useState('text'),[revealed,setRevealed]=React.useState(false);
 const [notice,setNotice]=React.useState('');
 const task=useScreenTask();
 const refresh=async()=>{
  setLoadError('');
  try {const r=await apiClient.savedValues();setItems(r.items);setLoaded(true);}
  catch(error){setLoadError(error instanceof PraxisApiError&&error.status===404?'Saved values are not available on this server yet. Update the server, then retry.':'Could not load saved values. Try again.');}
 };
 React.useEffect(()=>{void refresh();},[]);
 const create=()=>task.run(async()=>{
  let data:unknown=value;
  if(kind==='variable'&&format==='json'){try{data=JSON.parse(value);}catch{throw new Error('Enter valid JSON, or choose Text.');}}
  try{await apiClient.createSavedValue({name:name.trim(),kind,value:data});}
  catch(error){throw new Error(error instanceof PraxisApiError&&error.status===413?'Saved variables must be smaller than 64 KB.':'Could not save this value. Try again.');}
  setName('');setValue('');setRevealed(false);setNotice(kind==='secret'?'Secret saved. Its value stays hidden.':'Variable saved.');
  await refresh();
 });
 const available=loaded&&!loadError;
 return <>
  <Section title="Add a saved value" hint="Keep variables for later, or store credentials securely. Secret values are encrypted and write-only.">
   {loadError?<div role="alert" className={saved.loadError}><p>{loadError}</p><ScreenButton onClick={()=>void refresh()}>Retry loading</ScreenButton></div>:null}
   {!loaded&&!loadError?<p role="status">Loading saved values…</p>:null}
   <TaskError error={task.error}/>
   <form onSubmit={event=>{event.preventDefault();void create();}} className={saved.form}>
    <Field label="Name"><input aria-label="Saved value name" value={name} maxLength={100} disabled={!available||task.busy} onChange={e=>setName(e.target.value)} placeholder="For example, deployment_region"/></Field>
    <Field label="Type"><Select aria-label="Saved value type" value={kind} disabled={!available||task.busy} onChange={e=>{setKind(e.target.value as 'secret'|'variable');setRevealed(false);}}><option value="variable">Variable</option><option value="secret">Secret</option></Select></Field>
    {kind==='variable'?<Field label="Format"><Select aria-label="Variable format" value={format} disabled={!available||task.busy} onChange={e=>setFormat(e.target.value)}><option value="text">Text</option><option value="json">JSON</option></Select></Field>:null}
    <Field label="Value">{kind==='secret'?<input aria-label="Saved secret value" type={revealed?'text':'password'} autoComplete="off" value={value} disabled={!available||task.busy} onChange={e=>setValue(e.target.value)}/>:<textarea aria-label="Saved variable value" rows={3} value={value} disabled={!available||task.busy} onChange={e=>setValue(e.target.value)}/>}</Field>
    <div className={styles.actions}>{kind==='secret'?<ScreenButton disabled={!available||task.busy} aria-pressed={revealed} onClick={()=>setRevealed(v=>!v)}>{revealed?'Hide value':'Reveal value'}</ScreenButton>:null}<ScreenButton type="submit" tone="primary" disabled={!available||task.busy||!name.trim()||!value}>{task.busy?'Saving…':'Save value'}</ScreenButton></div>
   </form>
   {notice?<p role="status">{notice}</p>:null}
  </Section>
  <Section title="Saved values">
   {available&&!items.length?<p className={styles.empty}>No saved values yet.</p>:null}
   {items.map(item=><Card key={item.id}><div className={saved.entry} data-testid={`saved-value-${item.id}`}>
    <Field label={item.kind==='secret'?'Secret name':'Variable name'}><input aria-label={'Name for '+item.name} value={item.name} maxLength={100} onChange={e=>setItems(prev=>prev.map(s=>s.id===item.id?{...s,name:e.target.value}:s))}/></Field>
    {item.kind==='secret'?<p className={styles.intro}>Stored securely · Value hidden</p>:<pre className={saved.value}>{typeof item.value==='string'?item.value:JSON.stringify(item.value,null,2)}</pre>}
    <p className={styles.intro}>Created {new Date(item.createdAt).toLocaleDateString()} · Last used {item.lastUsedAt?new Date(item.lastUsedAt).toLocaleDateString():'Never'}</p>
    <div className={styles.actions}><ScreenButton disabled={task.busy||!item.name.trim()} onClick={()=>void task.run(async()=>{await apiClient.renameSavedValue(item.id,item.name);await refresh();})}>Rename</ScreenButton><ScreenButton tone="destructive" disabled={task.busy} onClick={()=>void task.run(async()=>{await apiClient.deleteSavedValue(item.id);await refresh();})}>Delete</ScreenButton></div>
   </div></Card>)}
  </Section>
 </>;
}
/** Compatibility for saved-secret previews and existing imports. */
export const SavedSecrets=SavedValues;
