import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_FILE = path.join(os.tmpdir(), `sm-test-${process.pid}.json`);
const { Hub } = await import('../src/monitor.js');

const prod = (o = {}) => ({ id: 'a', name: 'AJ4', url: 'https://x/a', price: 200, status: 'sold_out', sizes: [], ...o });
const setup = () => {
  const hub = new Hub();
  hub.notify = async () => true;
  const m = hub.add({ site: 'demo', target: 'https://demo.local' });
  return { hub, m };
};
const types = (hub) => hub.events.map((e) => e.type);

test('first run is a silent baseline', () => {
  const { hub, m } = setup();
  hub.diff(m, [prod()]);
  assert.equal(hub.events.length, 0);
});

test('detects restock', () => {
  const { hub, m } = setup();
  hub.diff(m, [prod()]); m.runs++;
  hub.diff(m, [prod({ status: 'in_stock' })]);
  assert.deepEqual(types(hub), ['restock']);
});

test('detects sell-out and price change together', () => {
  const { hub, m } = setup();
  hub.diff(m, [prod({ status: 'in_stock' })]); m.runs++;
  hub.diff(m, [prod({ status: 'sold_out', price: 180 })]);
  assert.deepEqual(types(hub).sort(), ['price', 'sold_out']);
});

test('detects newly listed products after baseline', () => {
  const { hub, m } = setup();
  hub.diff(m, [prod()]); m.runs++;
  hub.diff(m, [prod(), prod({ id: 'b', name: 'AJ1' })]);
  assert.deepEqual(types(hub), ['new']);
});

test('detects added sizes', () => {
  const { hub, m } = setup();
  hub.diff(m, [prod({ status: 'in_stock', sizes: ['9'] })]); m.runs++;
  hub.diff(m, [prod({ status: 'in_stock', sizes: ['9', '10'] })]);
  assert.deepEqual(types(hub), ['sizes']);
  assert.match(hub.events[0].message, /10/);
});

test('unchanged inventory produces no events', () => {
  const { hub, m } = setup();
  hub.diff(m, [prod()]); m.runs++;
  hub.diff(m, [prod()]);
  assert.equal(hub.events.length, 0);
});
