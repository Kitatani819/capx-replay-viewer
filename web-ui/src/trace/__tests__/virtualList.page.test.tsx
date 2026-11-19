import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, findAll, resetBrowser } from './harness/browser';
import { mount } from './harness/fakeReact';
import { VirtualList } from '../components/VirtualList';

// Node has no CSS.escape; the fixture only uses simple ASCII keys.
(globalThis as unknown as {CSS:unknown}).CSS={escape:(value:string)=>value};
const items=Array.from({length:100},(_,i)=>`row-${i}`);
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

test('disclosure changes discard offscreen cached heights and selection scrolling uses the new offsets', async () => {
  resetBrowser();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  let measure: ResizeObserverCallback;
  class Observer {
    constructor(callback: ResizeObserverCallback) { measure = callback; }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: Observer });
  try {
    const closed: Parameters<typeof VirtualList<string>>[0] = { ...props, scrollToKey: null, measurementKey: () => 'closed' };
    const page = mount(VirtualList<string>, closed);
    // Row zero was tall when last measured, but is now outside the viewport.
    const row = { dataset: { vkey: 'row-0', vmeasurement: 'closed' },
      getBoundingClientRect: () => ({ height: 1000 }) };
    measure!([{ target: row } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    await advance(16);
    const container = { scrollTop: 0, clientHeight: 100, scrollHeight: 10000,
      getBoundingClientRect: () => ({ top: 0, bottom: 100, height: 100 }), querySelector: () => null };
    (findAll(page.output, 'div')[0].props.ref as { current: unknown }).current = container;
    page.update({ ...closed, scrollToKey: 'row-50', scrollToken: 1 });
    await advance(16);
    assert.equal(container.scrollTop, 5870, 'the old measurement contributes to the selected offset');
    // A global switch changes even offscreen rows; their old heights must not
    // contribute while waiting for those rows to mount and be measured again.
    page.update({ ...closed, measurementKey: () => 'open', scrollToKey: 'row-50', scrollToken: 2 });
    await advance(16);
    assert.equal(container.scrollTop, 4970, 'new disclosure uses estimates instead of stale cached heights');
    // Measured changes after a thumbnail/details load refine the pending seek.
    row.dataset.vmeasurement = 'open';
    row.getBoundingClientRect = () => ({ height: 200 });
    measure!([{ target: row } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    await advance(32);
    assert.equal(container.scrollTop, 5070, 'ResizeObserver corrections use the new row geometry');
    page.unmount();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'ResizeObserver', previous);
    else Reflect.deleteProperty(globalThis, 'ResizeObserver');
  }
});
