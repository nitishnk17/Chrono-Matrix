import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'datasets');
const jsonPath = path.join(outDir, 'many-thread-trace.json');
const jsPath = path.join(outDir, 'many-thread-trace.js');

const THREADS = 24;
const CYCLES = 46;
const BASE_TS = 1700000100000000;
const resources = ['mutex_0xdead1000', 'mutex_0xdead1100', 'mutex_0xdead1200', 'mutex_0xdead1300', 'work_queue_cv', 'net-socket', 'log-file'];
const addrByResource = {
  mutex_0xdead1000: '0xAA001000',
  mutex_0xdead1100: '0xBB002000',
  mutex_0xdead1200: '0xCC003000',
  mutex_0xdead1300: '0xCC003060',
  work_queue_cv: '0xAA001040',
  'net-socket': '0xBB002040',
  'log-file': '0xCC003040',
};

function event(ts, tid, type, resource, duration, scenario, addr = '') {
  return { ts, tid, event: type, resource, addr, duration_us: duration, scenario };
}

const events = [];
const tids = Array.from({ length: THREADS }, (_, i) => 300100 + i * 37);

tids.forEach((tid, i) => {
  events.push(event(BASE_TS + i * 3500, tid, 'THREAD_START', `worker-${i}`, 0, 'startup'));
});

for (let i = 0; i < THREADS; i++) {
  const tid = tids[i];
  let ts = BASE_TS + 40000 + i * 1100;
  for (let c = 0; c < CYCLES; c++) {
    const res = resources[(i + c) % resources.length];
    const addr = addrByResource[res];
    const computeDur = 9000 + ((i * 997 + c * 431) % 42000);
    events.push(event(ts + computeDur, tid, 'COMPUTE', c % 4 === 0 ? 'vector-kernel' : '', computeDur, c % 4 === 0 ? 'compute' : 'pipeline', c % 5 === 0 ? `0x${(0xAA001000 + ((i * 64 + c * 128) % 0x2200)).toString(16).toUpperCase()}` : ''));
    ts += computeDur + 800;

    if ((c + i) % 3 === 0) {
      const waitDur = 4500 + ((i * 1543 + c * 811) % 90000);
      events.push(event(ts + waitDur, tid, 'LOCK_WAIT', res, waitDur, (c + i) % 11 === 0 ? 'cache-contention' : 'contention', addr));
      ts += waitDur + 450;
    }

    const acquireDur = 350 + ((i * 53 + c * 29) % 3600);
    events.push(event(ts + acquireDur, tid, 'LOCK_ACQUIRE', res, acquireDur, 'sync', addr));
    ts += acquireDur + 200;

    const criticalDur = 1800 + ((i * 617 + c * 193) % 18000);
    events.push(event(ts + criticalDur, tid, 'COMPUTE', 'critical-section', criticalDur, 'critical', addr));
    ts += criticalDur + 250;

    events.push(event(ts + 520, tid, 'LOCK_RELEASE', res, 520, 'sync', addr));
    ts += 900;

    if ((c + i) % 7 === 0) {
      const ioDur = 6000 + ((i * 701 + c * 389) % 65000);
      events.push(event(ts + ioDur, tid, 'IO_WAIT', 'net-socket', ioDur, 'io', addrByResource['net-socket']));
      ts += ioDur + 600;
    } else if ((c + i) % 5 === 0) {
      const sleepDur = 4500 + ((i * 421 + c * 277) % 45000);
      events.push(event(ts + sleepDur, tid, 'SLEEP', '', sleepDur, 'throttle'));
      ts += sleepDur + 600;
    }
  }
}

const deadlockBase = BASE_TS + 3650000;
for (const [offset, tid] of [[0, tids[5]], [1200, tids[17]]]) {
  events.push(event(deadlockBase + offset + 78000, tid, 'LOCK_WAIT', 'mutex_0xdead1300', 78000, 'deadlock-demo', addrByResource.mutex_0xdead1300));
  events.push(event(deadlockBase + offset + 160000, tid, 'DEADLOCK_DETECTED', 'mutex_0xdead1300', 82000, 'deadlock-demo', addrByResource.mutex_0xdead1300));
}

tids.forEach((tid, i) => {
  events.push(event(BASE_TS + 5600000 + i * 4200, tid, 'THREAD_END', `worker-${i}`, 0, 'shutdown'));
});

events.sort((a, b) => (a.ts - b.ts) || (a.tid - b.tid));

await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(jsonPath, `${JSON.stringify(events)}\n`);
await fs.writeFile(jsPath, `window.MANY_THREAD_TRACE=${JSON.stringify(events)};\n`);

console.log(JSON.stringify({
  file: path.relative(rootDir, jsonPath),
  events: events.length,
  threads: THREADS,
  deadlocks: events.filter(e => e.event === 'DEADLOCK_DETECTED').length,
  durationUs: events.at(-1).ts - events[0].ts,
}, null, 2));
