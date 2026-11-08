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
import React from 'react';
import {bindIcon} from '@praxis/glass';
import {Eye,SquarePen,Terminal,Search,Globe,MessageCircle,Wrench,CircleAlert} from 'lucide-react';
import type {WorkIcon} from './WorkEntry.logic';
import styles from './WorkLog.module.css';
const icons={read:bindIcon(Eye),edit:bindIcon(SquarePen),command:bindIcon(Terminal),search:bindIcon(Search),web:bindIcon(Globe),question:bindIcon(MessageCircle),tool:bindIcon(Wrench)};
const Alert=bindIcon(CircleAlert);
export function WorkEntryIcon({kind,failed=false,warning=false}:{kind:WorkIcon;failed?:boolean;warning?:boolean}) {
  const Icon=failed||warning?Alert:icons[kind];
  return <span className={styles.icon} data-kind={kind} data-tone={warning?'warning':failed?'error':undefined} aria-label={failed?'Tool call failed':warning?'Tool call denied':undefined} role={failed||warning?'img':undefined}><Icon size={16}/></span>;
}
/** WorkLogLine: a 24px icon slot, baseline-aligned label, then a disclosure chevron. */
export function WorkLogLine({icon,children,trailing}:{icon:React.ReactNode;children:React.ReactNode;trailing?:React.ReactNode}) {
  return <span className={styles.line}><span className={styles.main}><span className={styles.slot}>{icon}</span><span className={styles.label}>{children}</span></span>{trailing}</span>;
}
export {styles as workLogStyles};
