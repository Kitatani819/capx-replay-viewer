import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, findAll, resetBrowser } from './harness/browser';
import { mount } from './harness/fakeReact';
import { VirtualList } from '../components/VirtualList';

// Node has no CSS.escape; the fixture only uses simple ASCII keys.
(globalThis as unknown as {CSS:unknown}).CSS={escape:(value:string)=>value};
const items=Array.from({length:30},(_,i)=>`row-${i}`);
const props={items,itemKey:(item:string)=>item,estimateHeight:()=>100,renderItem:(item:string)=>item,
  scrollToKey:'row-10',scrollToken:0};

test('changing virtual row geometry cannot synchronously recurse while bringing the selection into view',async()=>{
  resetBrowser();let measurements=0;
  const container={scrollTop:0,clientHeight:100,
    getBoundingClientRect:()=>({top:0,bottom:100,height:100}),
    querySelector:()=>({getBoundingClientRect:()=>{
      // Real row mounts and native anchoring can change the measured position
      // before the ResizeObserver updates estimated offsets.
      if(++measurements>8)throw new Error('selection correction did not yield to a frame');
      const top=(measurements%2?600:900)-container.scrollTop;
      return {top,bottom:top+200,height:200};
    }})};
  const page=mount(VirtualList<string>,props);
  (findAll(page.output,'div')[0].props.ref as {current:unknown}).current=container;
  page.update({...props,scrollToken:1});
  await advance(0);
  assert.equal(measurements,0,'selection changes must allow layout/measurement before correction');
  await advance(80);
  assert.ok(measurements>0 && measurements<=5);
  assert.ok(page.renders<=7,'scroll correction is bounded by frames, not nested renders');
  (findAll(page.output,'div')[0].props.onWheel as Function)();
  const before=measurements;await advance(100);
  assert.equal(measurements,before,'manual scrolling cancels automatic corrections');
  page.unmount();
});

test('a hidden list waits for a visible viewport, then brings the selected row into view',async()=>{
  resetBrowser();let measurements=0;
  const container={scrollTop:0,clientHeight:0,
    getBoundingClientRect:()=>({top:0,bottom:container.clientHeight,height:container.clientHeight}),
    querySelector:()=>({getBoundingClientRect:()=>{measurements++;const top=800-container.scrollTop;return {top,bottom:top+80,height:80};}})};
  const page=mount(VirtualList<string>,props);
  (findAll(page.output,'div')[0].props.ref as {current:unknown}).current=container;
  page.update({...props,scrollToken:1});await advance(16);
  assert.equal(measurements,0);assert.equal(container.scrollTop,0);
  container.clientHeight=200;
  page.update({...props,scrollToken:2});await advance(32);
  assert.ok(measurements>0);
  const top=800-container.scrollTop;
  assert.ok(top>=0 && top+80<=200,'the selected row is visible after showing the detailed log');
  page.unmount();
});
