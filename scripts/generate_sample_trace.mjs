import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outJsonPath = path.join(rootDir, 'sample-trace.json');
const outJsPath = path.join(rootDir, 'sample-trace.js');
const sourceFiles = [
  'tracer/producer_consumer.json',
  'tracer/uneven_work_distribution.json',
  'tracer/deadlock.json',
  'tracer/wound_wait.json',
];

const traces = [];
for (const rel of sourceFiles) {
  const filePath = path.join(rootDir, rel);
  try {
    const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (Array.isArray(raw)) {
      traces.push(...raw);
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      throw err;
    }
  }
}

if (!traces.length) {
  throw new Error('No source program traces were found under tracer/. Run the demo programs first.');
}

const normalized = traces.map((event, index) => ({
  ...event,
  duration_us: Math.max(0, Number(event.duration_us) || 0),
  size: Math.max(0, Number(event.size) || 0),
  __index: index,
}));

const finalTrace = normalized
  .sort((a, b) => (a.ts - b.ts) || (a.tid - b.tid) || (a.__index - b.__index))
  .map(({ __index, ...event }) => event);

await fs.writeFile(outJsonPath, `${JSON.stringify(finalTrace)}\n`);
await fs.writeFile(outJsPath, `window.SAMPLE_TRACE=${JSON.stringify(finalTrace)};\n`);

console.log(JSON.stringify({
  file: path.relative(rootDir, outJsonPath),
  events: finalTrace.length,
  threads: new Set(finalTrace.map(event => event.tid)).size,
  deadlocks: finalTrace.filter(event => event.event === 'DEADLOCK_DETECTED').length,
  waits: finalTrace.filter(event => event.event === 'LOCK_WAIT' || event.event === 'LOCK_WAIT_TIMEOUT').length,
  durationUs: finalTrace.at(-1).ts - finalTrace[0].ts,
}, null, 2));
