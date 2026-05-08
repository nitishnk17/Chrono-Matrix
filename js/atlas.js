/**
 * atlas.js — Trace Atlas
 *
 * Fused temporal + spatial view:
 *   • Left: thread lanes over time
 *   • Right: address buckets over time
 *   • Shared filters with the rest of the dashboard
 */

const AtlasChart = (() => {
     const TIME_BINS = 72;
     const ADDR_BINS = 24;
     const TIMELINE_MARGIN = { top: 10, right: 20, bottom: 54, left: 76 };
     const SPACE_MARGIN = { top: 10, right: 20, bottom: 82, left: 90 };

     const EVENT_FOCUS = new Set([
          'COMPUTE', 'SLEEP', 'IO_WAIT', 'COND_WAIT',
          'LOCK_ACQUIRE', 'LOCK_WAIT', 'LOCK_RELEASE',
          'THREAD_JOIN', 'THREAD_START', 'THREAD_END',
          'DEADLOCK_DETECTED', 'MEM_READ', 'MEM_WRITE', 'MEM_ALLOC', 'MEM_FREE'
     ]);

     let allData = [];
     let filteredData = [];
     let tooltip = null;
     let currentTimeRange = null;
     let selectedThread = null;

     let timeBars = [];
     let spaceCells = [];
     let cellThreads = [];
     let cellThreadCounts = [];

     function formatUs(v) {
          if (v >= 1e6) return (v / 1e6).toFixed(2) + 's';
          if (v >= 1e3) return (v / 1e3).toFixed(1) + 'ms';
          return v.toFixed(0) + 'µs';
     }

     function formatAxisUs(v) {
          if (v <= 0) return '0';
          if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 's';
          if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'ms';
          return Math.round(v) + 'µs';
     }

     function addrBucket(addr) {
          if (typeof addr !== 'string' || !/^0x[0-9a-f]+$/i.test(addr)) return null;
          const min = 0xAA001000;
          const max = 0xCC003080;
          const v = parseInt(addr, 16);
          const span = Math.max(1, max - min);
          const pos = Math.max(0, Math.min(1, (v - min) / span));
          return Math.min(ADDR_BINS - 1, Math.floor(pos * ADDR_BINS));
     }

     function addrLabel(i) {
          const v = 0xAA001000 + Math.floor(i * (0xCC003080 - 0xAA001000) / ADDR_BINS);
          return '0x' + v.toString(16).toUpperCase().padStart(8, '0');
     }

     function activeData() {
          const data = currentTimeRange
               ? filteredData.filter(d => {
                    const s = d.ts - Math.max(0, d.duration_us || 0);
                    return (s <= currentTimeRange.t1 && d.ts >= currentTimeRange.t0);
               })
               : filteredData;
          return data.filter(d => EVENT_FOCUS.has(d.event));
     }

     function threadIsSelected(tid) {
          return selectedThread === null || selectedThread === tid;
     }

     function timelineContainer() {
          return document.getElementById('atlas-time-chart');
     }

     function spaceContainer() {
          return document.getElementById('atlas-space-chart');
     }

     function render() {
          renderTimeline();
          renderSpaceMap();
          updateMeta();
     }

     function updateMeta() {
          const data = activeData();
          const threads = [...new Set(data.map(d => d.tid))];
          const te = d3.extent(data.length ? data : filteredData, d => d.ts);
          const duration = (te[1] - te[0]) || 0;
          const memEvents = data.filter(d => d.event === 'MEM_READ' || d.event === 'MEM_WRITE' || d.event === 'MEM_ALLOC' || d.event === 'MEM_FREE').length;
          const timeMeta = document.getElementById('atlas-time-meta');
          const spaceMeta = document.getElementById('atlas-space-meta');
          if (timeMeta) timeMeta.textContent = `${threads.length} threads${selectedThread !== null ? ` · focus T-${selectedThread}` : ''} · ${formatUs(duration)}`;
          if (spaceMeta) spaceMeta.textContent = `${memEvents.toLocaleString()} memory events · ${TIME_BINS}×${ADDR_BINS} grid${selectedThread !== null ? ' · linked focus' : ''}`;
     }

     function renderTimeline() {
          const container = timelineContainer();
          if (!container) return;
          container.innerHTML = '';

          const data = activeData();
          if (!data.length) {
               container.innerHTML = '<div style="color:var(--text-muted);padding:16px">No timeline data.</div>';
               return;
          }

          const threads = [...new Set(data.map(d => d.tid))].sort((a, b) => a - b);
          const W = Math.max(420, container.clientWidth || 700);
          const H = Math.max(420, container.clientHeight || 540);
          const rowH = Math.max(18, Math.min(30, Math.floor((H - TIMELINE_MARGIN.top - TIMELINE_MARGIN.bottom) / Math.max(1, threads.length))));
          const innerH = Math.max(1, threads.length * rowH);
          const innerW = Math.max(1, W - TIMELINE_MARGIN.left - TIMELINE_MARGIN.right);
          const mainH = innerH + TIMELINE_MARGIN.top + TIMELINE_MARGIN.bottom;
          const te = [
               d3.min(data, d => d.ts - Math.max(0, d.duration_us || 0)),
               d3.max(data, d => d.ts)
          ];
          const xScl = d3.scaleLinear().domain(te).range([0, innerW]);
          const yScl = d3.scaleBand().domain(threads.map(String)).range([0, innerH]).padding(0.14);

          const wrap = document.createElement('div');
          wrap.style.cssText = `position:relative;width:${W}px;height:${mainH}px;`;
          container.appendChild(wrap);

          const dpr = window.devicePixelRatio || 1;
          const canvas = document.createElement('canvas');
          canvas.width = innerW * dpr;
          canvas.height = innerH * dpr;
          canvas.style.cssText = `position:absolute;left:${TIMELINE_MARGIN.left}px;top:${TIMELINE_MARGIN.top}px;width:${innerW}px;height:${innerH}px;cursor:crosshair;`;
          const ctx = canvas.getContext('2d');
          ctx.scale(dpr, dpr);
          wrap.appendChild(canvas);

          const svg = d3.select(wrap).append('svg')
               .attr('width', W).attr('height', mainH)
               .style('position', 'absolute').style('top', 0).style('left', 0)
               .style('pointer-events', 'none');

          svg.append('g')
               .attr('class', 'axis')
               .attr('transform', `translate(${TIMELINE_MARGIN.left},${TIMELINE_MARGIN.top})`)
               .call(d3.axisLeft(yScl).tickFormat(d => 'T-' + d));

          svg.append('g')
               .attr('class', 'axis')
               .attr('transform', `translate(${TIMELINE_MARGIN.left},${TIMELINE_MARGIN.top + innerH})`)
               .call(d3.axisBottom(xScl).ticks(6).tickFormat(v => formatUs(v - te[0])));

          svg.append('text')
               .attr('x', TIMELINE_MARGIN.left + innerW / 2)
               .attr('y', TIMELINE_MARGIN.top + innerH + 36)
               .attr('text-anchor', 'middle')
               .attr('fill', '#94a3b8')
               .attr('font-size', '10px')
               .attr('font-family', "'JetBrains Mono', monospace")
               .text('TIME →');

          const bands = threads.map(tid => ({
               tid,
               y: yScl(String(tid)),
               h: yScl.bandwidth()
          }));

          ctx.clearRect(0, 0, innerW, innerH);
          ctx.fillStyle = 'rgba(255,255,255,0.03)';
          bands.forEach((b, i) => {
               if (i % 2 === 0) ctx.fillRect(0, b.y, innerW, b.h);
          });

          timeBars = [];
          data.forEach(d => {
               const y = yScl(String(d.tid));
               if (y === undefined) return;
               const endT = d.ts;
               const startT = d.duration_us > 0 ? d.ts - d.duration_us : d.ts - 1;
               const x0 = xScl(startT);
               const x1 = xScl(endT);
               const x = Math.min(x0, x1);
               const w = Math.max(2, Math.abs(x1 - x0));
               const h = Math.max(5, yScl.bandwidth() * 0.72);
               const yy = y + (yScl.bandwidth() - h) / 2;
               const color = EventBus.colors[d.event] || '#94a3b8';
               const active = threadIsSelected(d.tid);

               ctx.fillStyle = color;
               ctx.globalAlpha = active ? (d.event === 'MEM_READ' || d.event === 'MEM_WRITE' ? 0.72 : 0.58) : 0.07;
               ctx.fillRect(x, yy, w, h);
               if (d.event === 'DEADLOCK_DETECTED') {
                    ctx.strokeStyle = '#ffffff';
                    ctx.lineWidth = 1;
                    ctx.strokeRect(x, yy, w, h);
               }
               if (selectedThread !== null && d.tid === selectedThread) {
                    ctx.strokeStyle = 'rgba(255,255,255,0.72)';
                    ctx.lineWidth = 1;
                    ctx.strokeRect(x - 0.5, yy - 0.5, w + 1, h + 1);
               }
               timeBars.push({ x, y: yy, w, h, d });
          });
          ctx.globalAlpha = 1;

          const legend = svg.append('g').attr('transform', `translate(${TIMELINE_MARGIN.left},${mainH - 22})`);
          const legendItems = ['COMPUTE', 'LOCK_WAIT', 'LOCK_WAIT_TIMEOUT', 'LOCK_ACQUIRE', 'COND_WAIT', 'IO_WAIT', 'MEM_READ', 'MEM_WRITE', 'DEADLOCK_DETECTED'];
          let lx = 0;
          legendItems.forEach(ev => {
               legend.append('rect')
                    .attr('x', lx).attr('y', 0).attr('width', 9).attr('height', 9)
                    .attr('rx', 2).attr('fill', EventBus.colors[ev] || '#94a3b8');
               legend.append('text')
                    .attr('x', lx + 12).attr('y', 8)
                    .attr('fill', '#94a3b8').attr('font-size', '9px')
                    .attr('font-family', "'JetBrains Mono', monospace")
                    .text(ev.replaceAll('_', ' '));
               lx += ev === 'DEADLOCK_DETECTED' ? 128 : 78;
          });

          canvas.addEventListener('mousemove', (e) => {
               const r = canvas.getBoundingClientRect();
               const mx = e.clientX - r.left;
               const my = e.clientY - r.top;
               const hit = timeBars.slice().reverse().find(bar =>
                    mx >= bar.x && mx <= bar.x + bar.w && my >= bar.y && my <= bar.y + bar.h
               );
               if (!hit || !tooltip) {
                    tooltip?.classList.remove('visible');
                    return;
               }

               const d = hit.d;
               tooltip.classList.add('visible');
               tooltip.innerHTML = `
                    <div class="tt-title">TRACE ATLAS</div>
                    <div class="tt-row"><span class="tt-key">Thread</span><span class="tt-val">T-${d.tid}</span></div>
                    <div class="tt-row"><span class="tt-key">Event</span><span class="tt-val">${d.event}</span></div>
                    <div class="tt-row"><span class="tt-key">Window</span><span class="tt-val">${formatUs(Math.max(0, d.ts - Math.max(0, d.duration_us || 0) - te[0]))} - ${formatUs(d.ts - te[0])}</span></div>
                    <div class="tt-row"><span class="tt-key">Duration</span><span class="tt-val">${formatUs(d.duration_us || 0)}</span></div>
                    ${d.resource ? `<div class="tt-row"><span class="tt-key">Resource</span><span class="tt-val">${d.resource}</span></div>` : ''}
                    ${d.addr ? `<div class="tt-row"><span class="tt-key">Addr</span><span class="tt-val">${d.addr}</span></div>` : ''}
                    ${d.size ? `<div class="tt-row"><span class="tt-key">Size</span><span class="tt-val">${d.size.toLocaleString()} bytes</span></div>` : ''}
                    ${d.scenario ? `<div class="tt-row"><span class="tt-key">Scenario</span><span class="tt-val">${d.scenario}</span></div>` : ''}
               `;
               EventBus.positionTooltip(tooltip, e);
          });
          canvas.addEventListener('mouseleave', () => tooltip?.classList.remove('visible'));
          canvas.addEventListener('click', (e) => {
               const r = canvas.getBoundingClientRect();
               const mx = e.clientX - r.left;
               const my = e.clientY - r.top;
               const hit = timeBars.slice().reverse().find(bar =>
                    mx >= bar.x && mx <= bar.x + bar.w && my >= bar.y && my <= bar.y + bar.h
               );
               const nextTid = hit ? hit.d.tid : null;
               EventBus.emit('threadSelect', { tid: selectedThread === nextTid ? null : nextTid });
          });
     }

     function renderSpaceMap() {
          const container = spaceContainer();
          if (!container) return;
          container.innerHTML = '';

          const data = activeData();
          if (!data.length) {
               container.innerHTML = '<div style="color:var(--text-muted);padding:16px">No spatial data.</div>';
               return;
          }

          const te = d3.extent(data, d => d.ts);
          const tRange = (te[1] - te[0]) || 1;
          const W = Math.max(360, container.clientWidth || 560);
          const H = Math.max(420, container.clientHeight || 540);
          const innerW = Math.max(1, W - SPACE_MARGIN.left - SPACE_MARGIN.right);
          const innerH = Math.max(1, H - SPACE_MARGIN.top - SPACE_MARGIN.bottom);
          const cellW = innerW / TIME_BINS;
          const cellH = innerH / ADDR_BINS;

          const countMatrix = Array.from({ length: ADDR_BINS }, () => new Int32Array(TIME_BINS));
          const readMatrix = Array.from({ length: ADDR_BINS }, () => new Int32Array(TIME_BINS));
          const writeMatrix = Array.from({ length: ADDR_BINS }, () => new Int32Array(TIME_BINS));
          const waitMatrix = Array.from({ length: ADDR_BINS }, () => new Float64Array(TIME_BINS));
          const sizeMatrix = Array.from({ length: ADDR_BINS }, () => new Float64Array(TIME_BINS));
          cellThreads = Array.from({ length: ADDR_BINS }, () => Array.from({ length: TIME_BINS }, () => new Set()));
          cellThreadCounts = Array.from({ length: ADDR_BINS }, () => Array.from({ length: TIME_BINS }, () => new Map()));

          data.forEach(d => {
               const ab = addrBucket(d.addr);
               if (ab === null) return;
               const tb = Math.min(TIME_BINS - 1, Math.max(0, Math.floor(((d.ts - te[0]) / tRange) * TIME_BINS)));
               countMatrix[ab][tb] += 1;
               cellThreads[ab][tb].add(d.tid);
               cellThreadCounts[ab][tb].set(d.tid, (cellThreadCounts[ab][tb].get(d.tid) || 0) + 1);
               if (d.event === 'MEM_READ') readMatrix[ab][tb] += 1;
               if (d.event === 'MEM_WRITE' || d.event === 'MEM_ALLOC' || d.event === 'MEM_FREE') writeMatrix[ab][tb] += 1;
               if (d.event === 'LOCK_WAIT' || d.event === 'DEADLOCK_DETECTED') waitMatrix[ab][tb] += d.duration_us || 0;
               if (d.size) sizeMatrix[ab][tb] += d.size;
          });

          const maxCount = d3.max(countMatrix.flatMap(r => [...r])) || 1;
          const maxBytes = d3.max(sizeMatrix.flatMap(r => [...r])) || 1;

          const wrap = document.createElement('div');
          wrap.style.cssText = `position:relative;width:${W}px;height:${H}px;`;
          container.appendChild(wrap);

          const dpr = window.devicePixelRatio || 1;
          const canvas = document.createElement('canvas');
          canvas.width = innerW * dpr;
          canvas.height = innerH * dpr;
          canvas.style.cssText = `position:absolute;left:${SPACE_MARGIN.left}px;top:${SPACE_MARGIN.top}px;width:${innerW}px;height:${innerH}px;cursor:crosshair;`;
          const ctx = canvas.getContext('2d');
          ctx.scale(dpr, dpr);
          wrap.appendChild(canvas);

          const svg = d3.select(wrap).append('svg')
               .attr('width', W).attr('height', H)
               .style('position', 'absolute').style('top', 0).style('left', 0)
               .style('pointer-events', 'none');

          const xScl = d3.scaleLinear().domain([0, TIME_BINS]).range([0, innerW]);
          const yScl = d3.scaleLinear().domain([0, ADDR_BINS]).range([0, innerH]);
          const timeTickValues = [0, TIME_BINS * 0.25, TIME_BINS * 0.5, TIME_BINS * 0.75, TIME_BINS];

          svg.append('rect')
               .attr('class', 'atlas-space-time-backdrop')
               .attr('x', SPACE_MARGIN.left)
               .attr('y', SPACE_MARGIN.top + innerH - 1)
               .attr('width', innerW)
               .attr('height', SPACE_MARGIN.bottom + 1);

          svg.append('g')
               .attr('class', 'axis atlas-space-time-axis')
               .attr('transform', `translate(${SPACE_MARGIN.left},${SPACE_MARGIN.top + innerH})`)
               .call(d3.axisBottom(xScl).tickValues(timeTickValues).tickFormat(i => formatAxisUs((i / TIME_BINS) * tRange)));

          svg.append('g')
               .attr('class', 'axis')
               .attr('transform', `translate(${SPACE_MARGIN.left},${SPACE_MARGIN.top})`)
               .call(d3.axisLeft(yScl).ticks(6).tickFormat(i => addrLabel(Math.round(i))));

          svg.append('text')
               .attr('class', 'atlas-space-time-label')
               .attr('x', SPACE_MARGIN.left + innerW / 2)
               .attr('y', H - 16)
               .attr('text-anchor', 'middle')
               .attr('fill', '#facc6b')
               .attr('font-size', '12px')
               .attr('font-weight', '800')
               .attr('font-family', "'JetBrains Mono', monospace")
               .text('TIME →');

          const palette = (readCount, writeCount) => {
               const total = Math.max(1, readCount + writeCount);
               const readRatio = readCount / total;
               const writeRatio = writeCount / total;
               const intensity = Math.min(1, total / maxCount);
               const base = writeRatio >= readRatio ? d3.interpolateRgb('#0d1b33', '#f97316')(intensity)
                                                     : d3.interpolateRgb('#0d1b33', '#38bdf8')(intensity);
               const c = d3.color(base);
               if (!c) return base;
               c.opacity = 0.78;
               return c.toString();
          };

          spaceCells = [];
          ctx.clearRect(0, 0, innerW, innerH);
          for (let ai = 0; ai < ADDR_BINS; ai++) {
               for (let ti = 0; ti < TIME_BINS; ti++) {
                    const val = countMatrix[ai][ti];
                    if (!val) continue;
                    const x = ti * cellW;
                    const y = ai * cellH;
                    ctx.fillStyle = palette(readMatrix[ai][ti], writeMatrix[ai][ti]);
                    ctx.fillRect(x, y, Math.max(1, cellW - 0.4), Math.max(1, cellH - 0.4));
                    if (waitMatrix[ai][ti] > 0) {
                         ctx.strokeStyle = 'rgba(239,68,68,0.7)';
                         ctx.lineWidth = 1;
                         ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, cellW - 1), Math.max(0, cellH - 1));
                    }
                    if (selectedThread !== null && cellThreads[ai][ti].has(selectedThread)) {
                         ctx.strokeStyle = 'rgba(255,255,255,0.82)';
                         ctx.lineWidth = 1.25;
                         ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, cellW - 1), Math.max(0, cellH - 1));
                    }
                    spaceCells.push({
                         x, y, w: cellW, h: cellH,
                         ai, ti,
                         count: val,
                         reads: readMatrix[ai][ti],
                         writes: writeMatrix[ai][ti],
                         wait: waitMatrix[ai][ti],
                         bytes: sizeMatrix[ai][ti]
                    });
               }
          }

          const maxFill = d3.max(spaceCells, d => d.bytes) || 1;
          const gradY = Math.max(0, innerH - 16);
          ctx.save();
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = 'rgba(255,255,255,0.04)';
          ctx.fillRect(0, gradY, innerW, 16);
          for (let i = 0; i < innerW; i++) {
               const t = i / Math.max(1, innerW);
               ctx.fillStyle = d3.interpolateRgb('#111827', '#e879f9')(t);
               ctx.fillRect(i, gradY, 1, 16);
          }
          ctx.restore();

          const legend = svg.append('g').attr('transform', `translate(${SPACE_MARGIN.left},${SPACE_MARGIN.top + innerH + 34})`);
          legend.append('text')
               .attr('fill', '#94a3b8').attr('font-size', '9px').attr('font-family', "'JetBrains Mono', monospace")
               .text(`cells: ${spaceCells.filter(d => d.count > 0).length.toLocaleString()}  ·  bytes max: ${maxFill.toLocaleString()}`);

          canvas.addEventListener('mousemove', (e) => {
               const r = canvas.getBoundingClientRect();
               const mx = e.clientX - r.left;
               const my = e.clientY - r.top;
               const ti = Math.max(0, Math.min(TIME_BINS - 1, Math.floor(mx / cellW)));
               const ai = Math.max(0, Math.min(ADDR_BINS - 1, Math.floor(my / cellH)));
               const cell = spaceCells.find(c => c.ai === ai && c.ti === ti);
               if (!cell || !tooltip) {
                    tooltip?.classList.remove('visible');
                    return;
               }
               tooltip.classList.add('visible');
               const binStart = te[0] + (ti / TIME_BINS) * tRange;
               const binEnd = te[0] + ((ti + 1) / TIME_BINS) * tRange;
               tooltip.innerHTML = `
                    <div class="tt-title">SPATIAL ADDRESS MAP</div>
                    <div class="tt-row"><span class="tt-key">Addr bin</span><span class="tt-val">${addrLabel(ai)} - ${addrLabel(Math.min(ADDR_BINS - 1, ai + 1))}</span></div>
                    <div class="tt-row"><span class="tt-key">Time window</span><span class="tt-val">${formatUs(binStart - te[0])} - ${formatUs(binEnd - te[0])}</span></div>
                    <div class="tt-row"><span class="tt-key">Events</span><span class="tt-val">${cell.count.toLocaleString()}</span></div>
                    ${cell.reads ? `<div class="tt-row"><span class="tt-key">Reads</span><span class="tt-val">${cell.reads.toLocaleString()}</span></div>` : ''}
                    ${cell.writes ? `<div class="tt-row"><span class="tt-key">Writes</span><span class="tt-val">${cell.writes.toLocaleString()}</span></div>` : ''}
                    ${cell.wait ? `<div class="tt-row"><span class="tt-key">Wait</span><span class="tt-val">${formatUs(cell.wait)}</span></div>` : ''}
                    ${cell.bytes ? `<div class="tt-row"><span class="tt-key">Bytes</span><span class="tt-val">${cell.bytes.toLocaleString()}</span></div>` : ''}
               `;
               EventBus.positionTooltip(tooltip, e);
          });
          canvas.addEventListener('mouseleave', () => tooltip?.classList.remove('visible'));
          canvas.addEventListener('click', (e) => {
               const r = canvas.getBoundingClientRect();
               const mx = e.clientX - r.left;
               const my = e.clientY - r.top;
               const ti = Math.max(0, Math.min(TIME_BINS - 1, Math.floor(mx / cellW)));
               const ai = Math.max(0, Math.min(ADDR_BINS - 1, Math.floor(my / cellH)));
               const tids = cellThreads[ai][ti];
               if (!tids || !tids.size) return;
               const counts = cellThreadCounts[ai][ti];
               let nextTid = null;
               let bestCount = -1;
               counts.forEach((count, tid) => {
                    if (count > bestCount) {
                         bestCount = count;
                         nextTid = tid;
                    }
               });
               EventBus.emit('threadSelect', { tid: selectedThread === nextTid ? null : nextTid });
          });
     }

     function init(data, tooltipEl) {
          allData = data;
          filteredData = data;
          tooltip = tooltipEl;
          render();
          bindBus();
     }

     function bindBus() {
          EventBus.on('scenarioFilter', ({ scenario }) => {
               filteredData = scenario === 'all' ? allData : allData.filter(d => d.scenario === scenario);
               render();
          });
          EventBus.on('timeRange', range => {
               currentTimeRange = range || null;
               render();
          });
          EventBus.on('threadSelect', ({ tid }) => {
               selectedThread = tid ?? null;
               render();
          });
     }

     return {
          init,
          triggerResize: () => {
               if (!allData.length) return;
               render();
          }
     };
})();
