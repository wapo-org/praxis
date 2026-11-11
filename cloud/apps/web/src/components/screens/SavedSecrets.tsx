import React from 'react';
import {apiClient} from '../../lib/api';
import {Section,Card,Field,ScreenButton,TaskError,useScreenTask} from './ScreenUI';
import styles from './Screen.module.css';

export function SavedSecrets() {
 const [items,setItems]=React.useState<{id:string;name:string;createdAt:string;lastUsedAt?:string}[]>([]);
 const task=useScreenTask();
 const refresh=async()=>{const r=await apiClient.savedSecrets();setItems(r.items);};
 React.useEffect(()=>{void task.run(refresh);},[]);
 return <Section title="Saved secrets" hint="Values are encrypted and write-only.">
  <TaskError error={task.error}/>
  {items.length?items.map(item=><Card key={item.id}><div style={{padding:'var(--space-4)',display:'grid',gap:'var(--space-3)'}}>
   <Field label="Secret name"><input aria-label={'Name for '+item.name} value={item.name} onChange={e=>setItems(prev=>prev.map(s=>s.id===item.id?{...s,name:e.target.value}:s))}/></Field>
   <p className={styles.intro}>Created {new Date(item.createdAt).toLocaleDateString()} · Last used {item.lastUsedAt?new Date(item.lastUsedAt).toLocaleDateString():'Never'}</p>
   <div className={styles.actions}>
    <ScreenButton disabled={task.busy||!item.name.trim()} onClick={()=>void task.run(async()=>{await apiClient.renameSavedSecret(item.id,item.name);await refresh();})}>Rename</ScreenButton>
    <ScreenButton tone="destructive" disabled={task.busy} onClick={()=>void task.run(async()=>{await apiClient.deleteSavedSecret(item.id);await refresh();})}>Delete</ScreenButton>
   </div>
  </div></Card>):<p className={styles.empty}>No saved secrets yet.</p>}
 </Section>;
}
