import {describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {zipSync,strToU8} from 'fflate';
import {createLocalAdapters} from '../../local-memory.js';
import type {FeatureContext} from '../../contracts.js';
import {extractSkill,importSkill,isMetadata} from './import.js';
import {createLocalToolsStorage} from './index.js';
const fixture=(name:string)=>new Uint8Array(readFileSync(new URL(`./fixtures/${name}`,import.meta.url)));
const doc='---\nname: demo\ndescription: Demo skill\n---\nFollow these steps.';
function ctx():FeatureContext{return {...createLocalAdapters(),local:false,userId:'alice',egress:vi.fn(),fetch:vi.fn()};}
describe('REV-R1 P1 5: archives made on macOS',()=>{
 // finder.zip: `ditto -c -k --sequesterRsrc --keepParent` (what Finder's Compress runs), with xattrs and a .DS_Store.
 // macos.tar.gz / macos-dot.tar: bsdtar 3.5.3 on macOS (AppleDouble `._*` entries, pax `x` headers, `.` root).
 it.each(['finder.zip','macos.tar.gz','macos-dot.tar'])('imports %s, skipping metadata',name=>{
  const result=extractSkill(fixture(name),name);
  expect(result.name).toBe('demo');expect(result.files).toEqual({'notes.md':'notes'});expect(result.dropped).toEqual([]);
 });
 it('recognizes only macOS metadata as skippable',()=>{
  for(const p of ['__MACOSX/','__MACOSX/demo/._SKILL.md','demo/._notes.md','._demo','demo/.DS_Store','./','.'])expect(isMetadata(p)).toBe(true);
  for(const p of ['SKILL.md','demo/notes.md','./SKILL.md','demo/.hidden','.._x'])expect(isMetadata(p)).toBe(false);
 });
 it('still counts skipped metadata against the caps and still rejects unsafe paths',()=>{
  expect(()=>extractSkill(zipSync({'SKILL.md':strToU8(doc),...Object.fromEntries(Array.from({length:100},(_,i)=>[`__MACOSX/._${i}`,strToU8('x')]))}),'a.zip')).toThrow();
  expect(()=>extractSkill(zipSync({'SKILL.md':strToU8(doc),'__MACOSX/._big':new Uint8Array(5_000_001)}),'a.zip')).toThrow();
  expect(()=>extractSkill(zipSync({'./SKILL.md':strToU8(doc),'./../x.md':strToU8('x')}),'a.zip')).toThrow();
 });
});
describe('REV-R1 P2: skill import is atomic',()=>{
 it('leaves no skill when writing its files fails',async()=>{
  const c=ctx(),s=createLocalToolsStorage('http://localhost');s.state!.put=vi.fn(async()=>{throw new Error('write failed');});
  await expect(importSkill(c,s,zipSync({'SKILL.md':strToU8(doc),'a.md':strToU8('a')}),'a.zip')).rejects.toThrow('write failed');
  expect((await c.store.list('alice','skill')).filter(r=>!r.deleted)).toEqual([]);
 });
 it('rolls the files back when the skill row is refused',async()=>{
  const c=ctx(),s=createLocalToolsStorage('http://localhost'),bytes=zipSync({'SKILL.md':strToU8(doc),'a.md':strToU8('a')});
  const first=await importSkill(c,s,bytes,'a.zip');const del=vi.spyOn(s.state!,'delete');
  await expect(importSkill(c,s,bytes,'a.zip')).rejects.toMatchObject({code:'skill_exists'});
  expect(del).toHaveBeenCalledTimes(1);expect(del.mock.calls[0]![2]).not.toBe(first.skill.id);
  expect(await s.state!.get('alice','skill',String(del.mock.calls[0]![2]))).toBeNull();
  expect(await s.state!.get('alice','skill',first.skill.id)).toMatchObject({files:{'a.md':'a'}});
 });
});
