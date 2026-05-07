const d3 = require('d3');
const rs = require('fs');

const data = [
  { ts: 8, tid: 373845, event: "LOCK_ACQUIRE", duration_us: 0 },
  { ts: 15090, tid: 373845, event: "LOCK_RELEASE", duration_us: 15087 }
];

const innerW = 1000;
const innerH = 100;
const timeExtent = [1, 20000];
const threads = ["373845", "373846"];

const xBase = d3.scaleLinear().domain(timeExtent).range([0, innerW]);
const yScale = d3.scaleBand().domain(threads).range([0, innerH]).padding(0.12);

const tx = 0;
const tk = 1;
const visT0 = xBase.invert(-tx / tk);
const visT1 = xBase.invert((innerW - tx) / tk);

console.log("visT0", visT0, "visT1", visT1);

data.forEach(d => {
    const startT = Math.max(0, d.ts - d.duration_us);
    if (d.ts < visT0 || startT > visT1) {
        console.log("Culled!", d);
        return;
    }

    const yBand = yScale(String(d.tid));
    const xStart = tx + xBase(startT) * tk;
    const xEnd = tx + xBase(d.ts) * tk;
    const w = Math.max(1.5, xEnd - xStart);
    const x = xEnd - w;
    const y = yBand + 2;
    const h = yScale.bandwidth() - 4;
    console.log(d.event, "=> x:", x, "y:", y, "w:", w, "h:", h);
});
