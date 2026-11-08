/*
 * Adapted from T3 Code WorkLog, TimelineWorkEntryRow, TimelineToolActivityIcon,
 * TimelineWorkGroupRows and MessagesTimeline (T3 Tools Inc.).
 * MIT License — Copyright (c) 2026 T3 Tools Inc.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type {ActiveToolStep} from '../../state/types';
import {toolRowCopy} from './toolRowCopy';
export type WorkIcon = 'read'|'edit'|'command'|'search'|'web'|'question'|'tool';
export function workEntry(step:ActiveToolStep) {
  const name=step.activity.name.toLowerCase();
  const category=step.activity.presentation?.category;
  const known:Partial<Record<string,WorkIcon>>={command:'command',webSearch:'web',webFetch:'web',readFile:'read',edit:'edit'};
  const icon:WorkIcon=known[category??'']??(/read|view|open_file|look_at/.test(name)?'read':/edit|write|patch/.test(name)?'edit':/exec|terminal|command|shell/.test(name)?'command':/web|browse|fetch/.test(name)?'web':/search|grep|find/.test(name)?'search':/elicit|question|ask_user/.test(name)?'question':'tool');
  let args:Record<string,unknown>={};try { const parsed=JSON.parse(step.argumentsJson||'{}');if(parsed&&typeof parsed==='object')args=parsed; }catch {/* Incomplete arguments are still expandable below. */}
  const first=(keys:string[])=>keys.map(k=>args[k]).find(v=>typeof v==='string') as string|undefined;
  const {title,summary}=toolRowCopy(step);
  const command=icon==='command'?first(['command','cmd','script']):undefined;
  const path=(icon==='read'||icon==='edit')?first(['path','file_path','filename','file']):undefined;
  const question=icon==='question'?first(['question','message','prompt']):undefined;
  const preview=command??path??first(['query','url','title'])??summary;
  const status=step.completion?.status;
  const failed=status==='failed',warning=status==='denied';
  const output=step.completion?.preview||step.completion?.summary||'';
  let answer=output;
  if(icon==='question')try{const value=JSON.parse(output);if(value&&typeof value==='object'&&!Array.isArray(value)){const fields=Object.entries(value).filter(([,v])=>['string','number','boolean'].includes(typeof v));if(fields.length)answer=fields.map(([k,v])=>`${k}: ${v}`).join('; ');}}catch{/* Plain answer text needs no transformation. */}
  const blocks=[step.argumentsJson&&step.argumentsJson!=='{}'?`Tool input\n${step.argumentsJson}`:'',step.progressLines.join('\n'),output].filter(Boolean);
  return {icon,title:question?'Asked':title,preview:question??preview,mono:!!(command||path),quoted:!!question||!!args.title,answer:icon==='question'?answer:'',failed,warning,body:[...new Set(blocks)].join('\n\n')};
}
