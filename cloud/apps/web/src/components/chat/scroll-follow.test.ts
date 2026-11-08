import {describe,it,expect} from 'vitest';
import {scrollMetrics} from './useStreamAnchor';
describe('scroll follow geometry',()=>{
  it('never offers a jump for a short chat, including elastic overscroll',()=>{
    expect(scrollMetrics({scrollHeight:500,clientHeight:800,scrollTop:-30}).showJump).toBe(false);
    expect(scrollMetrics({scrollHeight:800,clientHeight:800,scrollTop:0}).showJump).toBe(false);
  });
  it('clamps browser overscroll and uses the actual distance rather than stale state',()=>{
    expect(scrollMetrics({scrollHeight:1500,clientHeight:800,scrollTop:0}).showJump).toBe(true);
    expect(scrollMetrics({scrollHeight:1500,clientHeight:800,scrollTop:705})).toMatchObject({showJump:false,distance:0});
    expect(scrollMetrics({scrollHeight:1500,clientHeight:1400,scrollTop:0}).showJump).toBe(false);
  });
});
