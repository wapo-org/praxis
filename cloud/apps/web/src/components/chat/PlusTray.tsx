import React from 'react';
import { GlassSurface } from '@praxis/glass';
import { Camera, Photo, Paperclip, Scan, Folder, Copy, Globe, Link, Settings } from '../../lib/icons';
import { usePraxisStore } from '../../state/store';
import { ModelPicker } from './ModelPicker';
export { getUnpinnedModels } from './ModelPicker';
export interface PlusTrayProps { onPickFiles: (accept?: string, capture?: boolean) => void }
const effortDetail: Record<string, string> = { low: 'Quick answers, minimal tool use', medium: 'Balanced: a few tools, checked once', high: 'Thorough: plans first, verifies after', max: 'Exhaustive: plans, verifies, retries' };
export function PlusTray({ onPickFiles }: PlusTrayProps) {
  const store = usePraxisStore();
  if (!store.plusTrayOpen) return null;
  const model = store.models.find(m => m.providerId === store.selectedProviderId && m.id === store.selectedModelId);
  const efforts = model?.reasoningEfforts ?? [];
  return <GlassSurface radius={28} material="regular" data-testid="plus-tray" className="plus-tray">
    <div className="tray-segments" role="group" aria-label="Mode">
      {(['auto', 'ask', 'plan', 'build'] as const).map(mode => <button key={mode} data-testid={`tray-mode-${mode}`} aria-pressed={mode === store.selectedMode} onClick={() => store.setSelectedMode(mode)}>{mode}</button>)}
    </div>
    <ModelPicker />
    {efforts.length > 0 && <div><div className="tray-segments" role="group" aria-label="Reasoning effort">
      {efforts.map(effort => <button key={effort} aria-pressed={effort === store.selectedEffort} onClick={() => store.setSelectedEffort(effort)}>{effort}</button>)}
    </div><p className="tray-detail">{effortDetail[store.selectedEffort] || 'Reasoning effort for this model.'}</p></div>}
    <div className="tray-media">
      {[
        { name: 'Photos', Icon: Photo, accept: 'image/*' }, { name: 'Camera', Icon: Camera, accept: 'image/*', capture: true },
        { name: 'Files', Icon: Folder, accept: '*/*' }, { name: 'Screenshot', Icon: Copy, accept: 'image/*' },
      ].map(({ name, Icon, accept, capture }) => <button key={name} data-testid={`tray-tile-${name.toLowerCase()}`} onClick={() => onPickFiles(accept, capture)}><Icon size={22} /><span>{name}</span></button>)}
    </div>
    <button className="tray-photo-access" onClick={() => onPickFiles('image/*')}>Allow Photos access</button>
    <p className="tray-detail">Choose a saved screenshot from your files. Your browser grants access only to selected photos.</p>
    <label className="tray-toggle"><Globe size={18} /><span>Web search</span><input role="switch" aria-label="Web search" type="checkbox" checked={store.webSearch && !!model?.capabilities.serverWebSearch} disabled={!model?.capabilities.serverWebSearch} onChange={e => store.setWebSearch(e.target.checked)} /></label>
    {!model?.capabilities.serverWebSearch && <p className="tray-detail">This model does not support hosted web search.</p>}
    <button className="tray-model-row" onClick={() => store.setActiveSheet('connectors')}><Link size={18} />Connectors<span>{store.connectors.filter(c => c.enabled).length || 'None'}</span></button>
    {store.activeChat && store.connectors.filter(c => c.enabled).map(connector => <label key={connector.id} className="tray-toggle"><span>{connector.name}</span><input type="checkbox" checked={!store.activeChat!.disabledConnectorIds.includes(connector.id)} onChange={e => void store.toggleChatConnector(store.activeChat!.id, connector.id, e.target.checked)} /></label>)}
    <button className="tray-model-row" onClick={() => store.setActiveSheet('providers')}><Settings size={18} />Model providers</button>
  </GlassSurface>;
}
