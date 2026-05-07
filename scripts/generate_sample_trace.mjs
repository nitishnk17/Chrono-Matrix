import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const jsonPath = path.join(rootDir, 'sample-trace.json');
const jsPath = path.join(rootDir, 'sample-trace.js');

const RESOURCE_ADDR = new Map([
  ['mutex_0xdead1000', '0xAA001000'],
  ['mutex_0xdead1100', '0xBB002000'],
  ['mutex_0xdead1200', '0xCC003000'],
  ['mutex_0xdead1300', '0xCC003060'],
  ['work_queue_cv', '0xAA001040'],
  ['net-socket', '0xBB002040'],
  ['net-send', '0xBB002060'],
  ['log-file', '0xCC003040'],
  ['shared-resource', '0xAA001080'],
]);

function hashString(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function fallbackAddr(event) {
  if (typeof event.addr === 'string' && /^0x[0-9a-f]+$/i.test(event.addr)) {
    return event.addr.toUpperCase();
  }
  if (RESOURCE_ADDR.has(event.resource)) {
    return RESOURCE_ADDR.get(event.resource);
  }

  const span = 0xCC003080 - 0xAA001000;
  const offset = hashString(`${event.resource}|${event.event}|${event.tid}`) % Math.max(span, 1);
  return `0x${(0xAA001000 + offset).toString(16).toUpperCase()}`;
}

const original = JSON.parse(await fs.readFile(jsonPath, 'utf8'));

const enriched = original.map((event, index) => ({
  ...event,
  duration_us: Math.max(0, Number(event.duration_us) || 0),
  addr: fallbackAddr(event),
  __index: index,
}));

const baseTs = enriched.findLast(event => event.scenario === 'critical')?.ts ?? enriched.at(-1)?.ts ?? 1700000004300000;
const deadlockScenario = 'deadlock-demo';
const deadlockEvents = [
  {
    ts: baseTs + 18000,
    tid: 200665,
    event: 'LOCK_WAIT',
    resource: 'mutex_0xdead1300',
    addr: '0xCC003060',
    duration_us: 82000,
    scenario: deadlockScenario,
  },
  {
    ts: baseTs + 24000,
    tid: 200891,
    event: 'LOCK_WAIT',
    resource: 'mutex_0xdead1300',
    addr: '0xCC003060',
    duration_us: 78000,
    scenario: deadlockScenario,
  },
  {
    ts: baseTs + 100000,
    tid: 200665,
    event: 'DEADLOCK_DETECTED',
    resource: 'mutex_0xdead1300',
    addr: '0xCC003060',
    duration_us: 82000,
    scenario: deadlockScenario,
  },
  {
    ts: baseTs + 100500,
    tid: 200891,
    event: 'DEADLOCK_DETECTED',
    resource: 'mutex_0xdead1300',
    addr: '0xCC003060',
    duration_us: 78000,
    scenario: deadlockScenario,
  },
].map((event, index) => ({ ...event, __index: enriched.length + index }));

const finalTrace = [...enriched, ...deadlockEvents]
  .sort((a, b) => (a.ts - b.ts) || (a.tid - b.tid) || (a.__index - b.__index))
  .map(({ __index, ...event }) => event);

await fs.writeFile(jsonPath, `${JSON.stringify(finalTrace)}\n`);
await fs.writeFile(jsPath, `window.SAMPLE_TRACE=${JSON.stringify(finalTrace)};\n`);

const summary = {
  events: finalTrace.length,
  threads: new Set(finalTrace.map(event => event.tid)).size,
  durationUs: finalTrace.at(-1).ts - finalTrace[0].ts,
  deadlocks: finalTrace.filter(event => event.event === 'DEADLOCK_DETECTED').length,
};

console.log(JSON.stringify(summary, null, 2));
