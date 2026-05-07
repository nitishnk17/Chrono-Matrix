/**
 * overview.js — Overview Page Charts
 *
 * Charts:
 *   1. KPI metric cards (6)
 *   2. Event Density Area Chart (events per time bin)
 *   3. Top Waiters Horizontal Bar Chart
 *   4. Event Type Distribution Bar Chart
 */

const OverviewCharts = (() => {
     let allData = [], filteredData = [];

     function formatUs(v) {
          if (v >= 1e6) return (v / 1e6).toFixed(2) + 's';
          if (v >= 1e3) return (v / 1e3).toFixed(1) + 'ms';
          return v.toFixed(0) + 'µs';
     }

     function formatNum(v) {
          if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
          if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
          return v.toString();
     }

     function init(data) {
          allData = data;
          filteredData = data;
          renderAll();
          bindBus();
     }

     function renderAll() {
          renderKPIs();
          renderDensity();
          renderTopWaiters();
          renderEvTypeChart();
     }

     // ── KPI Cards ─────────────────────────────────────────
     function renderKPIs() {
          const data = filteredData;
          const threads = new Set(data.map(d => d.tid));
          const scenarios = new Set(data.map(d => d.scenario));
          const te = d3.extent(data, d => d.ts);
          const duration = (te[1] - te[0]) || 1;
          let wait = 0, blockingEvents = 0, deadlocks = 0, compute_explicit = 0;
          const threadSpans = {};

          data.forEach(d => {
               const startT = d.ts - (d.duration_us || 0);
               if (!threadSpans[d.tid]) {
                    threadSpans[d.tid] = { min: startT, max: d.ts };
               } else {
                    threadSpans[d.tid].min = Math.min(threadSpans[d.tid].min, startT);
                    threadSpans[d.tid].max = Math.max(threadSpans[d.tid].max, d.ts);
               }

               if (d.event === 'COMPUTE') compute_explicit += d.duration_us;
               else if (d.event === 'SLEEP' || d.event === 'IO_WAIT' || d.event === 'COND_WAIT' || d.event === 'LOCK_WAIT' || d.event === 'LOCK_WAIT_TIMEOUT' || d.event === 'THREAD_JOIN') {
                    wait += d.duration_us;
                    blockingEvents++;
               }

               if (d.event === 'DEADLOCK_DETECTED') deadlocks++;
          });

          let totalSpan = 0;
          for (const t in threadSpans) {
               totalSpan += (threadSpans[t].max - threadSpans[t].min);
          }
          if (totalSpan <= 0) totalSpan = 1;

          let realCompute = totalSpan - wait;
          if (realCompute < 0) realCompute = 0;

          const efficiency = ((realCompute / totalSpan) * 100).toFixed(1);

          const cards = [
               { label: 'Total Events', val: formatNum(data.length), sub: data.length.toLocaleString() + ' records', color: 'var(--cyan)', accent: 'var(--cyan)' },
               { label: 'Active Threads', val: threads.size, sub: `${scenarios.size} scenarios · distinct thread IDs`, color: 'var(--blue)', accent: 'var(--blue)' },
               { label: 'Trace Duration', val: formatUs(duration), sub: 'real execution time', color: 'var(--green)', accent: 'var(--green)' },
               { label: 'CPU Efficiency', val: efficiency + '%', sub: 'compute vs total wall time', color: efficiency > 70 ? 'var(--green)' : 'var(--amber)', accent: efficiency > 70 ? 'var(--green)' : 'var(--amber)' },
               { label: 'Blocking Events', val: formatNum(blockingEvents), sub: formatUs(wait) + ' blocked', color: 'var(--amber)', accent: 'var(--amber)' },
               { label: 'Deadlocks', val: deadlocks, sub: deadlocks > 0 ? '⚠ detected' : '✓ clean', color: deadlocks > 0 ? 'var(--purple)' : 'var(--green)', accent: deadlocks > 0 ? 'var(--purple)' : 'var(--green)' },
          ];

          document.getElementById('kpi-grid').innerHTML = cards.map(c => `
            <div class="kpi-card" style="--accent-color:${c.accent};--meter-width:${c.label === 'CPU Efficiency' ? c.val : (c.label === 'Deadlocks' ? (deadlocks > 0 ? '100%' : '12%') : '64%')}">
                <div class="kpi-accent"></div>
                <div class="kpi-head">
                    <div class="kpi-label">${c.label}</div>
                    <div class="kpi-pulse"></div>
                </div>
                <div class="kpi-value" style="color:${c.color}">${c.val}</div>
                <div class="kpi-sub">${c.sub}</div>
                <div class="kpi-meter"><span></span></div>
            </div>
        `).join('');
     }

     // ── Event Density Area Chart ───────────────────────────
     function renderDensity() {
          const container = document.getElementById('density-chart');
          container.innerHTML = '';

          const BINS = 80;
          const data = filteredData;
          if (!data.length) return;

          const te = d3.extent(data, d => d.ts);
          const tRange = (te[1] - te[0]) || 1;

          // Count events per time bin, split by event type
          const eventTypes = ['COMPUTE', 'SLEEP', 'IO_WAIT', 'COND_WAIT', 'LOCK_WAIT', 'LOCK_WAIT_TIMEOUT', 'LOCK_ACQUIRE', 'LOCK_RELEASE', 'THREAD_JOIN', 'THREAD_START', 'THREAD_END', 'DEADLOCK_DETECTED', 'MEM_READ', 'MEM_WRITE', 'MEM_ALLOC', 'MEM_FREE'];
          // Use EventBus colors
          const colors = EventBus.colors;

          const bins = Array.from({ length: BINS }, () => ({ ts: 0 }));
          const counts = {};
          eventTypes.forEach(t => counts[t] = new Array(BINS).fill(0));

          data.forEach(d => {
               const b = Math.min(BINS - 1, Math.floor(((d.ts - te[0]) / tRange) * BINS));
               bins[b].ts = te[0] + (b / BINS) * tRange;
               if (counts[d.event]) counts[d.event][b]++;
          });

          const W = Math.max(320, container.clientWidth || 680);
          const H = Math.max(280, container.clientHeight || 0);
          const M = { top: 14, right: 24, bottom: 46, left: 58 };
          const iW = Math.max(1, W - M.left - M.right);
          const iH = Math.max(1, H - M.top - M.bottom);

          const xScl = d3.scaleLinear().domain([0, BINS - 1]).range([0, iW]);
          const maxAll = d3.max(eventTypes.flatMap(t => counts[t])) || 1;
          const svg = d3.select(container).append('svg')
               .attr('width', W).attr('height', H)
               .attr('viewBox', `0 0 ${W} ${H}`)
               .attr('preserveAspectRatio', 'none')
               .style('width', '100%')
               .style('height', '100%');
          const g = svg.append('g').attr('transform', `translate(${M.left},${M.top})`);
          // Stacked area logic via d3.stack
          const stack = d3.stack()
               .keys(eventTypes)
               .value((d, key) => d[key]);

          // Format data for stack
          const stackData = bins.map((b, i) => {
               const row = { ts: b.ts };
               eventTypes.forEach(t => row[t] = counts[t][i]);
               row.total = eventTypes.reduce((sum, t) => sum + row[t], 0);
               row.bin = i;
               return row;
          });

          const series = stack(stackData);
          const maxStack = d3.max(series, s => d3.max(s, d => d[1])) || 1;
          const yScl = d3.scaleLinear().domain([0, maxStack]).range([iH, 0]).nice();

          const areaFn = d3.area()
               .x(d => xScl(bins.findIndex(b => b.ts === d.data.ts)))
               .y0(d => yScl(d[0]))
               .y1(d => yScl(d[1]))
               .curve(d3.curveBasis);

          g.selectAll('.area-layer')
               .data(series)
               .join('path')
               .attr('class', 'area-layer')
               .attr('d', areaFn)
               .attr('fill', d => colors[d.key])
               .attr('opacity', 0.85)
               .attr('stroke', 'rgba(0,0,0,0.2)')
               .attr('stroke-width', 0.5);

          const hover = g.append('g')
               .attr('class', 'density-hover')
               .style('display', 'none')
               .style('pointer-events', 'none');

          hover.append('line')
               .attr('class', 'density-hover-line')
               .attr('y1', 0)
               .attr('y2', iH)
               .attr('stroke', 'rgba(203,213,225,0.72)')
               .attr('stroke-width', 1)
               .attr('stroke-dasharray', '4,4');

          hover.append('circle')
               .attr('class', 'density-hover-dot')
               .attr('r', 4.5)
               .attr('fill', '#f8fafc')
               .attr('stroke', '#020617')
               .attr('stroke-width', 1.5);

          const moveTooltip = (event) => {
               const tooltip = document.getElementById('global-tooltip');
               if (!tooltip) return;

               const [mx] = d3.pointer(event, g.node());
               const bin = Math.max(0, Math.min(BINS - 1, Math.round(xScl.invert(mx))));
               const row = stackData[bin];
               const total = row.total || 0;
               const x = xScl(bin);
               const y = yScl(total);

               hover.style('display', null);
               hover.select('.density-hover-line')
                    .attr('x1', x)
                    .attr('x2', x);
               hover.select('.density-hover-dot')
                    .attr('cx', x)
                    .attr('cy', y);

               const nonZero = eventTypes
                    .map(t => ({ type: t, count: row[t] || 0 }))
                    .filter(d => d.count > 0)
                    .sort((a, b) => b.count - a.count);
               const shown = nonZero.slice(0, 7);
               const hidden = Math.max(0, nonZero.length - shown.length);
               const start = formatUs((bin / BINS) * tRange);
               const end = formatUs(((bin + 1) / BINS) * tRange);
               const rows = shown.map(d => `
                    <div class="tt-row density-tt-row">
                         <span class="tt-key"><i style="background:${colors[d.type] || '#94a3b8'}"></i>${d.type.replaceAll('_', ' ')}</span>
                         <span class="tt-val">${d.count.toLocaleString()}</span>
                    </div>
               `).join('');

               tooltip.classList.add('visible');
               tooltip.innerHTML = `
                    <div class="tt-title">Activity Rhythm</div>
                    <div class="tt-row"><span class="tt-key">Time window</span><span class="tt-val">${start} - ${end}</span></div>
                    <div class="tt-row"><span class="tt-key">Total events</span><span class="tt-val">${total.toLocaleString()}</span></div>
                    ${rows || '<div class="tt-row"><span class="tt-key">No events</span><span class="tt-val">0</span></div>'}
                    ${hidden ? `<div class="tt-row"><span class="tt-key">Other types</span><span class="tt-val">+${hidden}</span></div>` : ''}
               `;
               tooltip.style.left = Math.min(event.clientX + 16, window.innerWidth - 280) + 'px';
               tooltip.style.top = Math.max(event.clientY - 18, 10) + 'px';
          };

          g.append('rect')
               .attr('class', 'density-hover-catcher')
               .attr('width', iW)
               .attr('height', iH)
               .attr('fill', 'transparent')
               .style('cursor', 'crosshair')
               .on('mouseenter', moveTooltip)
               .on('mousemove', moveTooltip)
               .on('mouseleave', () => {
                    hover.style('display', 'none');
                    const tooltip = document.getElementById('global-tooltip');
                    if (tooltip) tooltip.classList.remove('visible');
               });

          g.append('g').attr('class', 'axis').attr('transform', `translate(0,${iH})`)
               .call(d3.axisBottom(xScl).ticks(6).tickFormat(i => formatUs((i / BINS) * tRange)));

          // Y axis
          g.append('g').attr('class', 'axis').call(d3.axisLeft(yScl).ticks(4).tickFormat(d3.format('.0s')));

          // Y-axis label "EVENTS / BIN"
          g.append('text').attr('x', -iH / 2).attr('y', -35)
               .attr('text-anchor', 'middle').attr('transform', 'rotate(-90)')
               .attr('fill', '#94a3b8').attr('font-size', '10px')
               .attr('font-family', "'JetBrains Mono',monospace")
               .text('EVENTS / BIN');

          // X-axis label "TRACE TIME →"
          g.append('text').attr('x', iW / 2).attr('y', iH + 32)
               .attr('text-anchor', 'middle').attr('fill', '#94a3b8').attr('font-size', '10px')
               .attr('font-family', "'JetBrains Mono',monospace")
               .text('TRACE TIME →');

          document.getElementById('density-meta').textContent = `${BINS} time bins · ${data.length.toLocaleString()} events`;
     }

     // ── Scenario Donut ────────────────────────────────────
     function renderDonut() {
          const container = document.getElementById('donut-chart');
          container.innerHTML = '';

          const scenarios = d3.rollup(filteredData, v => v.length, d => d.scenario);
          const total = filteredData.length || 1;
          const W = container.clientWidth || 260;
          const H = 220;
          const radius = Math.min(W, H) / 2 - 20;

          const COLORS = { producer_consumer: '#29b6f6', deadlock: '#e53935', false_sharing: '#ffb74d' };
          const LABELS = {
               producer_consumer: 'Producer-Consumer',
               deadlock: 'Deadlock',
               'deadlock-demo': 'Deadlock Demo',
               false_sharing: 'False Sharing',
               'wound_wait_thread_0': 'Wound-Wait T0',
               'wound_wait_thread_1': 'Wound-Wait T1',
               uncategorized: 'Uncategorized'
          };

          const pie = d3.pie().value(d => d[1]).sort(null);
          const arc = d3.arc().innerRadius(radius * 0.55).outerRadius(radius);
          const arcH = d3.arc().innerRadius(radius * 0.55).outerRadius(radius + 6);

          const svg = d3.select(container).append('svg').attr('width', W).attr('height', H);
          const g = svg.append('g').attr('transform', `translate(${W / 2},${H / 2 - 10})`);

          const arcs = g.selectAll('g').data(pie([...scenarios])).join('g');
          arcs.append('path')
               .attr('d', arc)
               .attr('fill', d => COLORS[d.data[0]] || '#888')
               .attr('stroke', 'rgba(0,0,0,0.3)')
               .style('cursor', 'pointer')
               .on('mouseover', (event, d) => {
                    const tooltip = document.getElementById('global-tooltip');
                    tooltip.classList.add('visible');
                    tooltip.innerHTML = `
                         <div class="tt-title">${LABELS[d.data[0]] || d.data[0]}</div>
                         <div class="tt-row"><span class="tt-key">Events</span><span class="tt-val">${formatNum(d.data[1])}</span></div>
                         <div class="tt-row"><span class="tt-key">Share</span><span class="tt-val">${((d.data[1] / total) * 100).toFixed(1)}%</span></div>
                    `;
                    tooltip.style.left = Math.min(event.clientX + 14, window.innerWidth - 200) + 'px';
                    tooltip.style.top = Math.max(event.clientY - 10, 10) + 'px';
               })
               .on('mouseout', () => document.getElementById('global-tooltip').classList.remove('visible'))
               .transition().duration(600).attrTween('d', function (d) {
                    const i = d3.interpolate({ startAngle: 0, endAngle: 0 }, d);
                    return t => arc(i(t));
               });

          arcs.append('text')
               .attr('transform', d => `translate(${arc.centroid(d)})`)
               .attr('text-anchor', 'middle').attr('dy', '0.35em')
               .attr('fill', 'white').attr('font-size', '12px')
               .attr('font-family', "'JetBrains Mono',monospace")
               .style('pointer-events', 'none')
               .text(d => (d.endAngle - d.startAngle > 0.4) ? ((d.data[1] / total) * 100).toFixed(0) + '%' : '');

          // Centre label
          g.append('text').attr('text-anchor', 'middle').attr('dy', '-0.1em')
               .attr('fill', 'var(--cyan)').attr('font-family', "'Orbitron',monospace").attr('font-size', '1.1rem')
               .text(formatNum(filteredData.length));
          g.append('text').attr('text-anchor', 'middle').attr('dy', '1.2em')
               .attr('fill', 'var(--text-secondary)').attr('font-size', '11px').text('EVENTS');

          // Legend below
          const legG = svg.append('g').attr('transform', `translate(${W / 2},${H - 22})`);
          const legPad = W / (scenarios.size + 1);
          let li = 0;
          scenarios.forEach((cnt, sc) => {
               legG.append('rect').attr('x', (li - scenarios.size / 2) * legPad - 4).attr('y', -5)
                    .attr('width', 8).attr('height', 8).attr('rx', 2).attr('fill', COLORS[sc] || '#888');
               legG.append('text')
                    .attr('x', (li - scenarios.size / 2) * legPad + 7).attr('y', 4)
                    .attr('fill', 'var(--text-secondary)').attr('font-size', '11px')
                    .text(LABELS[sc] || sc);
               li++;
          });
     }

     // ── Top Waiters ───────────────────────────────────────
     function renderTopWaiters() {
          const container = document.getElementById('waiters-chart');
          container.innerHTML = '';

          const threadWait = {};
          const BLOCKING_EVENTS = new Set(['SLEEP', 'IO_WAIT', 'COND_WAIT', 'LOCK_WAIT', 'LOCK_WAIT_TIMEOUT', 'THREAD_JOIN', 'DEADLOCK_DETECTED']);
          filteredData.forEach(d => {
               if (BLOCKING_EVENTS.has(d.event)) {
                    threadWait[d.tid] = (threadWait[d.tid] || 0) + d.duration_us;
               }
          });

          const sorted = Object.entries(threadWait).sort((a, b) => b[1] - a[1]).slice(0, 10);
          if (!sorted.length) { container.innerHTML = '<div style="color:var(--text-muted);padding:20px">No wait events.</div>'; return; }

          const W = Math.max(320, container.clientWidth || 360);
          const H = Math.max(260, container.clientHeight || 0);
          const M = { top: 10, right: 76, bottom: 42, left: 92 };
          const iW = Math.max(1, W - M.left - M.right);
          const iH = Math.max(1, H - M.top - M.bottom);

          const yScl = d3.scaleBand().domain(sorted.map(d => 'T-' + d[0])).range([0, iH]).padding(0.2);
          const xScl = d3.scaleLinear().domain([0, sorted[0][1]]).range([0, iW]).nice();

          const svg = d3.select(container).append('svg')
               .attr('width', W).attr('height', H)
               .attr('viewBox', `0 0 ${W} ${H}`)
               .style('width', '100%')
               .style('height', '100%');
          const g = svg.append('g').attr('transform', `translate(${M.left},${M.top})`);

          // Gradient for bars
          const defs = svg.append('defs');
          const grad = defs.append('linearGradient').attr('id', 'waiter-grad').attr('x1', '0%').attr('x2', '100%');
          grad.append('stop').attr('offset', '0%').attr('stop-color', '#e53935');
          grad.append('stop').attr('offset', '100%').attr('stop-color', '#ab47bc');

          g.selectAll('.w-bar')
               .data(sorted)
               .join('rect')
               .attr('class', 'w-bar')
               .attr('x', 0)
               .attr('y', d => yScl('T-' + d[0]))
               .attr('height', yScl.bandwidth())
               .attr('rx', 3)
               .attr('fill', 'url(#waiter-grad)')
               .attr('width', 0)
               .transition().duration(500).delay((_, i) => i * 40)
               .attr('width', d => Math.max(2, xScl(d[1])));

          // Value labels
          g.selectAll('.w-lbl')
               .data(sorted)
               .join('text')
               .attr('class', 'w-lbl')
               .attr('x', d => xScl(d[1]) + 5)
               .attr('y', d => yScl('T-' + d[0]) + yScl.bandwidth() / 2)
               .attr('dy', '0.35em')
               .attr('fill', 'var(--text-secondary)')
               .attr('font-size', '11px')
               .attr('font-family', "'JetBrains Mono',monospace")
               .text(d => formatUs(d[1]));

          g.append('g')
               .attr('class', 'axis waiters-y-axis')
               .call(d3.axisLeft(yScl))
               .call(ax => {
                    ax.selectAll('.tick text')
                         .attr('fill', '#d8e1ef')
                         .attr('font-size', '12px')
                         .attr('font-family', "'IBM Plex Mono',monospace")
                         .attr('font-weight', '600');
                    ax.selectAll('.tick line').remove();
                    ax.select('.domain').attr('stroke', 'rgba(100,116,139,0.30)');
               });
          g.append('g').attr('class', 'axis').attr('transform', `translate(0,${iH})`)
               .call(d3.axisBottom(xScl).ticks(4).tickFormat(formatUs));

          // X-axis label "TOTAL WAIT TIME"
          g.append('text').attr('x', iW / 2).attr('y', iH + 28)
               .attr('text-anchor', 'middle').attr('fill', '#94a3b8').attr('font-size', '10px')
               .attr('font-family', "'JetBrains Mono',monospace")
               .text('TOTAL WAIT TIME');
     }

     // ── Event Type Horizontal Bar Chart ──────────────────
     function renderEvTypeChart() {
          const container = document.getElementById('evtype-chart');
          container.innerHTML = '';

          const counts = d3.rollup(filteredData, v => v.length, d => d.event);
          const COLORS = {
               COMPUTE: '#4caf50', SLEEP: '#94a3b8', IO_WAIT: '#fbc02d', COND_WAIT: '#f472b6',
               LOCK_ACQUIRE: '#fb923c', LOCK_WAIT: '#f87171', LOCK_WAIT_TIMEOUT: '#ef4444', LOCK_RELEASE: '#38bdf8',
               DEADLOCK_DETECTED: '#c084fc', MEM_READ: '#38bdf8', MEM_WRITE: '#f97316', MEM_ALLOC: '#22c55e', MEM_FREE: '#a855f7'
          };
          const LABELS = {
               COMPUTE: 'COMPUTE', SLEEP: 'SLEEP', IO_WAIT: 'I/O WAIT', COND_WAIT: 'COND WAIT',
               LOCK_ACQUIRE: 'ACQUIRE', LOCK_WAIT: 'LOCK WAIT', LOCK_WAIT_TIMEOUT: 'WAIT TIMEOUT', LOCK_RELEASE: 'RELEASE',
               DEADLOCK_DETECTED: 'DEADLOCK', MEM_READ: 'MEM READ', MEM_WRITE: 'MEM WRITE', MEM_ALLOC: 'MEM ALLOC', MEM_FREE: 'MEM FREE'
          };
          const ORDER = ['COMPUTE', 'LOCK_ACQUIRE', 'LOCK_WAIT', 'LOCK_WAIT_TIMEOUT', 'LOCK_RELEASE', 'SLEEP', 'IO_WAIT', 'COND_WAIT', 'MEM_READ', 'MEM_WRITE', 'MEM_ALLOC', 'MEM_FREE', 'DEADLOCK_DETECTED'];
          const data2 = ORDER.filter(e => counts.has(e)).map(e => ({ ev: e, cnt: counts.get(e) }));

          const W = Math.max(320, container.clientWidth || 360);
          const M = { top: 14, right: 62, bottom: 34, left: 96 };
          const H = Math.max(260, container.clientHeight || 0);
          const ROW_H = Math.max(24, (H - M.top - M.bottom) / Math.max(data2.length, 1));
          const iW = Math.max(1, W - M.left - M.right);
          const maxCnt = d3.max(data2, d => d.cnt) || 1;

          const xScl = d3.scaleLinear().domain([0, maxCnt]).range([0, iW]).nice();
          const iH = Math.max(1, H - M.top - M.bottom);
          const yScl = d3.scaleBand().domain(data2.map(d => d.ev)).range([0, iH]).padding(0.22);

          const svg = d3.select(container).append('svg')
               .attr('width', W).attr('height', H)
               .attr('viewBox', `0 0 ${W} ${H}`)
               .style('width', '100%')
               .style('height', '100%')
               .style('overflow', 'visible');
          const g = svg.append('g').attr('transform', `translate(${M.left},${M.top})`);

          // Subtle alternating row background
          g.selectAll('.ev-row-bg')
               .data(data2)
               .join('rect')
               .attr('class', 'ev-row-bg')
               .attr('x', -M.left)
               .attr('y', d => yScl(d.ev))
               .attr('width', W)
               .attr('height', yScl.bandwidth())
               .attr('fill', (_, i) => i % 2 === 0 ? 'rgba(255,255,255,0.03)' : 'transparent');

          // Bars — animate from 0
          const defs = svg.append('defs');
          data2.forEach(d => {
               const col = COLORS[d.ev] || '#64748b';
               const grad = defs.append('linearGradient')
                    .attr('id', `evg-${d.ev}`)
                    .attr('x1', '0%').attr('x2', '100%');
               grad.append('stop').attr('offset', '0%').attr('stop-color', col).attr('stop-opacity', 0.9);
               grad.append('stop').attr('offset', '100%').attr('stop-color', col).attr('stop-opacity', 0.4);
          });

          g.selectAll('.ev-bar')
               .data(data2)
               .join('rect')
               .attr('class', 'ev-bar')
               .attr('x', 0)
               .attr('y', d => yScl(d.ev) + 1)
               .attr('height', yScl.bandwidth() - 2)
               .attr('rx', 3)
               .attr('fill', d => `url(#evg-${d.ev})`)
               .attr('width', 0)
               .transition().duration(600).delay((_, i) => i * 55).ease(d3.easeCubicOut)
               .attr('width', d => Math.max(4, xScl(d.cnt)));

          // Event type label (left side)
          g.selectAll('.ev-lbl')
               .data(data2)
               .join('text')
               .attr('class', 'ev-lbl')
               .attr('x', -8)
               .attr('y', d => yScl(d.ev) + yScl.bandwidth() / 2)
               .attr('dy', '0.35em')
               .attr('text-anchor', 'end')
               .attr('fill', d => COLORS[d.ev] || '#94a3b8')
               .attr('font-size', '10px')
               .attr('font-weight', '600')
               .attr('font-family', "'JetBrains Mono',monospace")
               .text(d => LABELS[d.ev] || d.ev);

          // Count label (right end of bar)
          g.selectAll('.ev-cnt')
               .data(data2)
               .join('text')
               .attr('class', 'ev-cnt')
               .attr('x', d => xScl(d.cnt) + 5)
               .attr('y', d => yScl(d.ev) + yScl.bandwidth() / 2)
               .attr('dy', '0.35em')
               .attr('fill', '#64748b')
               .attr('font-size', '10px')
               .attr('font-family', "'JetBrains Mono',monospace")
               .text(d => d.cnt >= 1000 ? (d.cnt / 1000).toFixed(1) + 'k' : d.cnt);

          // X-axis (bottom) — minimal, just a few ticks
          g.append('g')
               .attr('class', 'axis evtype-xaxis')
               .attr('transform', `translate(0,${iH})`)
               .call(d3.axisBottom(xScl).ticks(4).tickFormat(d3.format('.0s')))
               .call(ax => {
                    ax.selectAll('text')
                         .style('font-size', '9px')
                         .style('font-family', "'JetBrains Mono',monospace")
                         .style('fill', '#475569');
                    ax.select('.domain').attr('stroke', 'rgba(0,245,255,0.1)');
                    ax.selectAll('.tick line').attr('stroke', 'rgba(0,245,255,0.1)');
               });
     }

     // ── EventBus ──────────────────────────────────────────
     function bindBus() {
          EventBus.on('scenarioFilter', ({ scenario }) => {
               filteredData = scenario === 'all' ? allData : allData.filter(d => d.scenario === scenario);
               if (document.getElementById('page-overview').classList.contains('active')) renderAll();
          });
          EventBus.on('timeRange', () => {
               if (document.getElementById('page-overview').classList.contains('active')) renderDensity();
          });
     }

     function triggerResize() {
          if (!allData.length) return;
          renderAll();
     }

     return { init, triggerResize };
})();
