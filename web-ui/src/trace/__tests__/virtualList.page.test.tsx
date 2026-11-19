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

test('changing selection without a scroll token cancels the pending request', async () => {
  resetBrowser();
  let measurements = 0;
  const container = { scrollTop: 500, clientHeight: 200, scrollHeight: 10000,
    getBoundingClientRect: () => ({ top: 0, bottom: 200, height: 200 }),
    querySelector: () => ({ getBoundingClientRect: () => {
      measurements++;
      const top = 2000 - container.scrollTop;
      return { top, bottom: top + 500, height: 500 };
    } }) };
  const page = mount(VirtualList<string>, props);
  try {
    (findAll(page.output, 'div')[0].props.ref as { current: unknown }).current = container;
    page.update({ ...props, scrollToKey: 'row-20' });
    await advance(64);
    assert.equal(container.scrollTop, 500, 'a selection change alone must not move the list');
    assert.equal(measurements, 0, 'the previous pending request must be cancelled as well');
    page.update({ ...props, scrollToKey: 'row-20', scrollToken: 1 });
    await advance(32);
    assert.ok(measurements > 0, 'an explicit request still measures and reveals the selected row');
    assert.equal(container.scrollTop, 1940);
  } finally {
    page.unmount();
  }
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

test('measured heights above the viewport leave native anchoring to real rows', async () => {
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
  const idle = { ...props, scrollToKey: null, overscanPx: 200 };
  const page = mount(VirtualList<string>, idle);
  try {
    let top = 3000;
    let writes = 0;
    const container = {
      get scrollTop() { return top; },
      set scrollTop(value: number) { writes++; top = value; },
      clientHeight: 300, scrollHeight: 10000,
      getBoundingClientRect: () => ({ top: 0, bottom: 300, height: 300 }),
      querySelector: () => null,
    };
    (findAll(page.output, 'div')[0].props.ref as { current: unknown }).current = container;
    page.update({ ...idle, items: [...items] });
    await advance(0);
    const spacers = () => findAll(page.output, 'div').slice(1).map(element => element.props.style as { height: number; overflowAnchor: string });
    assert.deepEqual(spacers().map(style => style.overflowAnchor), ['none', 'none'],
      'neither spacer may prevent a visible row from becoming the browser scroll anchor');
    assert.equal((findAll(page.output, 'div')[0].props.style as { overflowAnchor: string }).overflowAnchor, 'auto');
    const before = spacers()[0].height;
    const rowTop = 3100 - top;
    // A late measurement for an offscreen row increases the leading spacer.
    // The DOM harness has no layout engine; apply the browser's native anchor
    // adjustment directly, then ensure the virtualizer does not overwrite it.
    const row = { dataset: { vkey: 'row-0' }, getBoundingClientRect: () => ({ height: 160 }) };
    measure!([{ target: row } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    top += 60;
    await advance(64);
    assert.equal(spacers()[0].height, before + 60, 'the spacer reflects the measured height above the viewport');
    assert.equal(3160 - container.scrollTop, rowTop, 'the real row retains its viewport position');
    assert.equal(writes, 0, 'measurement updates must not compete with native scroll anchoring');
  } finally {
    page.unmount();
    if (previous) Object.defineProperty(globalThis, 'ResizeObserver', previous);
    else Reflect.deleteProperty(globalThis, 'ResizeObserver');
  }
});

test('equivalent rows and measurement callbacks preserve offscreen measured heights', async () => {
  resetBrowser();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  let measure: ResizeObserverCallback;
  class Observer {
    constructor(callback: ResizeObserverCallback) { measure = callback; }
    observe() {} unobserve() {} disconnect() {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: Observer });
  const idle = { ...props, scrollToKey: null, measurementKey: () => 'unchanged' };
  const page = mount(VirtualList<string>, idle);
  try {
    const row = { dataset: { vkey: 'row-0', vmeasurement: 'unchanged' }, getBoundingClientRect: () => ({ height: 1000 }) };
    measure!([{ target: row } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    await advance(16);
    const container = { scrollTop: 3000, clientHeight: 300, scrollHeight: 10900,
      getBoundingClientRect: () => ({ top: 0, bottom: 300, height: 300 }), querySelector: () => null };
    (findAll(page.output, 'div')[0].props.ref as { current: unknown }).current = container;
    page.update({ ...idle, items: [...items] });
    await advance(0);
    const leadingHeight = () => (findAll(page.output, 'div')[1].props.style as { height: number }).height;
    const before = leadingHeight();
    page.update({ ...idle, items: [...items], itemKey: item => item,
      estimateHeight: () => 100, measurementKey: () => 'unchanged' });
    await advance(64);
    assert.equal(leadingHeight(), before, 'fresh arrays and functions do not replace measured heights with estimates');
    assert.equal(container.scrollTop, 3000);
  } finally {
    page.unmount();
    if (previous) Object.defineProperty(globalThis, 'ResizeObserver', previous);
    else Reflect.deleteProperty(globalThis, 'ResizeObserver');
  }
});

for (const outer of ['document', 'pane'] as const) {
test(`a growing summary above the list preserves the visible row in the outer ${outer}`, async () => {
  resetBrowser();
  const resizeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  const scrollDescriptor = Object.getOwnPropertyDescriptor(document, 'scrollingElement');
  const heightDescriptor = Object.getOwnPropertyDescriptor(window, 'innerHeight');
  const styleDescriptor = Object.getOwnPropertyDescriptor(window, 'getComputedStyle');
  const listenerDescriptor = Object.getOwnPropertyDescriptor(window, 'addEventListener');
  const addListener = window.addEventListener;
  let scrollListener: (() => void) | undefined;
  Object.defineProperty(window, 'addEventListener', { configurable: true,
    value: (type: string, listener: () => void, options?: boolean | AddEventListenerOptions) => {
      if (type === 'scroll') scrollListener = listener;
      addListener.call(window, type, listener, options);
    } });
  const observers: Array<{ callback: ResizeObserverCallback; targets: Set<unknown> }> = [];
  class Observer {
    targets = new Set<unknown>();
    constructor(readonly callback: ResizeObserverCallback) { observers.push(this); }
    observe(target: unknown) { this.targets.add(target); }
    unobserve(target: unknown) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: Observer });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  let summaryHeight = 150, documentTop = 80, pageWrites = 0;
  const scroller = {
    get scrollTop() { return documentTop; },
    set scrollTop(value: number) { documentTop = value; pageWrites++; },
    clientHeight: 700, scrollHeight: 2000,
    parentElement: null as unknown, previousElementSibling: null,
  };
  const documentScroller = outer === 'document' ? scroller : { scrollTop: 0, parentElement: null, previousElementSibling: null };
  if (outer === 'pane') scroller.parentElement = documentScroller;
  Object.defineProperty(window, 'getComputedStyle', { configurable: true,
    value: (target: unknown) => ({ overflowY: outer === 'pane' && target === scroller ? 'auto' : 'visible' }) });
  Object.defineProperty(document, 'scrollingElement', { configurable: true, value: documentScroller });
  const summary = { previousElementSibling: null };
  const layout = { parentElement: scroller, previousElementSibling: summary };
  const container = {
    scrollTop: 450, clientHeight: 300, scrollHeight: 10000,
    parentElement: layout, previousElementSibling: null,
    getBoundingClientRect: () => {
      const top = summaryHeight + 60 - documentTop;
      return { top, bottom: top + 300, height: 300 };
    },
    querySelector: () => null,
  };
  const idle = { ...props, scrollToKey: null };
  // Attach the fake DOM before layout effects, as React does in the browser.
  const page = mount((p: typeof idle) => {
    const output = VirtualList(p);
    (output.props.ref as { current: unknown }).current = container;
    return output;
  }, idle);
  try {
    await advance(32);
    const rowTop = () => container.getBoundingClientRect().top + 500 - container.scrollTop;
    const before = rowTop(), listTop = container.scrollTop;
    const observer = observers.find(item => item.targets.has(summary));
    assert.ok(observer, 'the observer includes a summary sibling above the layout, outside the list scrollport');
    if (!observer) throw new Error('missing outer layout observer');
    summaryHeight += 120;
    observer.callback([{ target: summary } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    await advance(64);
    assert.equal(rowTop(), before, 'summary growth must not move the row on screen');
    assert.equal(scroller.scrollTop, 200, 'the enclosing scrollport absorbs the layout displacement');
    if (outer === 'pane') assert.equal(documentScroller.scrollTop, 0, 'a nested scroll pane absorbs its own displacement');
    assert.equal(container.scrollTop, listTop, 'the list keeps its own reading position');
    assert.equal(pageWrites, 1);
    // If native page anchoring already compensated a later image load, there
    // is no residual displacement and the virtualizer must not apply it twice.
    summaryHeight += 90; documentTop += 90;
    observer.callback([{ target: summary } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    await advance(64);
    assert.equal(rowTop(), before);
    assert.equal(pageWrites, 1, 'native compensation is preserved without another scroll write');
    documentTop += 40;
    scrollListener!();
    const afterManualScroll = rowTop();
    summaryHeight += 70;
    observer.callback([{ target: summary } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    await advance(64);
    assert.equal(rowTop(), afterManualScroll, 'a manual scroll establishes the new reading position');
    assert.equal(pageWrites, 2);
  } finally {
    page.unmount();
    for (const [target, key, descriptor] of [
      [globalThis, 'ResizeObserver', resizeDescriptor], [document, 'scrollingElement', scrollDescriptor],
      [window, 'innerHeight', heightDescriptor], [window, 'getComputedStyle', styleDescriptor],
      [window, 'addEventListener', listenerDescriptor],
    ] as const) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    }
  }
});
}
