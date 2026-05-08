/**
 * profiler.js — Thread Profiler Page
 *
 * Charts:
 *   1. Per-thread Compute vs Wait area chart over time
 *   2. Event distribution donut for selected thread
 *   3. Thread mini-stats cards
 */

const ProfilerCharts = (() => {
     let allData = [], filteredData = [];
     let selectedTid = null;

     function formatUs(v) {
          if (v >= 1e6) return (v / 1e6).toFixed(2) + 's';
          if (v >= 1e3) return (v / 1e3).toFixed(1) + 'ms';
          return v.toFixed(0) + 'µs';
     }

     function init(data) {
          allData = data;
          filteredData = data;
          populateSelector();
          bindBus();
     }

     function populateSelector() {
          const threads = [...new Set(filteredData.map(d => d.tid))].sort((a, b) => a - b);
          const sel = document.getElementById('thread-selector');
          sel.innerHTML = threads.map(t => `<option value="${t}">Thread T-${t}</option>`).join('');

          if (!threads.includes(selectedTid)) {
               selectedTid = threads[0] || null;
          }
          sel.value = selectedTid;

          sel.onchange = () => {
               selectedTid = +sel.value;
               EventBus.emit('threadSelect', { tid: selectedTid });
               renderProfiler();
          };
          renderProfiler();
     }

     function renderProfiler() {
          if (selectedTid === null) {
               document.getElementById('profiler-area-chart').innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center">No data for selected thread.</div>';
               document.getElementById('profiler-donut').innerHTML = '';
               document.getElementById('profiler-stats-cards').innerHTML = '';
               return;
          }
          const threadData = filteredData.filter(d => d.tid === selectedTid);
          if (!threadData.length) {
               document.getElementById('profiler-area-chart').innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center">No data for selected thread in this scenario.</div>';
               document.getElementById('profiler-donut').innerHTML = '';
               document.getElementById('profiler-stats-cards').innerHTML = '';
               return;
          }

          renderAreaChart(threadData);
          renderEventDonut(threadData);
          renderProfilerStats(threadData);
     }

     // ── Compute vs Wait Area Chart ────────────────────────
     function renderAreaChart(data) {
          const container = document.getElementById('profiler-area-chart');
          container.innerHTML = '';

          const BINS = 60;
          const te = d3.extent(data, d => d.ts);
          const tRange = (te[1] - te[0]) || 1;

          const binCompute = new Array(BINS).fill(0);
          const binWait = new Array(BINS).fill(0);
          const binSleep = new Array(BINS).fill(0);
          const binCond = new Array(BINS).fill(0);
          const binIO = new Array(BINS).fill(0);
          const binJoin = new Array(BINS).fill(0);

          data.forEach(d => {
               const b = Math.min(BINS - 1, Math.floor(((d.ts - te[0]) / tRange) * BINS));
               if (d.event === 'COMPUTE') binCompute[b] += d.duration_us;
               else if (d.event === 'LOCK_WAIT') binWait[b] += d.duration_us;
               else if (d.event === 'SLEEP') binSleep[b] += d.duration_us;
               else if (d.event === 'COND_WAIT') binCond[b] += d.duration_us;
               else if (d.event === 'IO_WAIT') binIO[b] += d.duration_us;
               else if (d.event === 'THREAD_JOIN') binJoin[b] += d.duration_us;
          });

          const maxY = Math.max(d3.max(binCompute), d3.max(binWait), d3.max(binSleep), d3.max(binCond), d3.max(binIO), d3.max(binJoin)) || 1;

          const W = Math.max(360, container.clientWidth || 700);
          const H = Math.max(520, container.clientHeight || 0);
          const M = { top: 24, right: 30, bottom: 45, left: 65 };
          const iW = Math.max(1, W - M.left - M.right), iH = Math.max(1, H - M.top - M.bottom);

          const xScl = d3.scaleLinear().domain([0, BINS - 1]).range([0, iW]);
          const yScl = d3.scaleLinear().domain([0, maxY]).range([iH, 0]).nice();

          const svg = d3.select(container).append('svg')
               .attr('width', W).attr('height', H)
               .attr('viewBox', `0 0 ${W} ${H}`)
               .style('width', '100%')
               .style('height', '100%');

          // Grid
          const defs = svg.append('defs');
          const profileSeries = [
               { key: 'COMPUTE', label: 'Compute', sum: d3.sum(binCompute), bins: binCompute, grad: 'gr-c' },
               { key: 'LOCK_WAIT', label: 'Lock Wait', sum: d3.sum(binWait), bins: binWait, grad: 'gr-w' },
               { key: 'SLEEP', label: 'Sleep', sum: d3.sum(binSleep), bins: binSleep, grad: 'gr-s' },
               { key: 'COND_WAIT', label: 'Cond Wait', sum: d3.sum(binCond), bins: binCond, grad: 'gr-co' },
               { key: 'IO_WAIT', label: 'I/O Wait', sum: d3.sum(binIO), bins: binIO, grad: 'gr-io' },
               { key: 'THREAD_JOIN', label: 'Thread Join', sum: d3.sum(binJoin), bins: binJoin, grad: 'gr-j' }
          ].map(s => ({ ...s, color: EventBus.colors[s.key] || '#94a3b8' }));

          profileSeries.forEach(({ grad: id, color }) => {
               const g = defs.append('linearGradient').attr('id', id).attr('x1', '0%').attr('x2', '0%').attr('y1', '0%').attr('y2', '100%');
               g.append('stop').attr('offset', '0%').attr('stop-color', color).attr('stop-opacity', 0.52);
               g.append('stop').attr('offset', '100%').attr('stop-color', color).attr('stop-opacity', 0);
          });

          const g = svg.append('g').attr('transform', `translate(${M.left},${M.top})`);

          // Grid lines
          yScl.ticks(4).forEach(t => {
               g.append('line').attr('x1', 0).attr('x2', iW).attr('y1', yScl(t)).attr('y2', yScl(t))
                    .attr('stroke', 'rgba(0,245,255,0.06)').attr('stroke-dasharray', '3,4');
          });

          const makeArea = (bins, color, gradId) => {
               const areaFn = d3.area().x((_, i) => xScl(i)).y0(iH).y1((_, i) => yScl(bins[i])).curve(d3.curveBasis);
               const lineFn = d3.line().x((_, i) => xScl(i)).y((_, i) => yScl(bins[i])).curve(d3.curveBasis);
               g.append('path').datum(bins).attr('d', areaFn).attr('fill', `url(#${gradId})`).style('mix-blend-mode', 'screen');
               g.append('path').datum(bins).attr('d', lineFn).attr('fill', 'none').attr('stroke', color).attr('stroke-width', 2).style('mix-blend-mode', 'screen');
          };

          // Draw the arrays sorted by sum to keep small ones visible
          profileSeries.sort((a, b) => b.sum - a.sum).forEach(s => makeArea(s.bins, s.color, s.grad));

          // Axes
          g.append('g').attr('class', 'axis').attr('transform', `translate(0,${iH})`)
               .call(d3.axisBottom(xScl).ticks(6).tickFormat(i => formatUs((i / BINS) * tRange)));
          g.append('g').attr('class', 'axis').call(d3.axisLeft(yScl).ticks(4).tickFormat(formatUs));

          // Axis labels
          g.append('text').attr('x', iW / 2).attr('y', iH + 40).attr('text-anchor', 'middle').attr('fill', '#94a3b8').attr('font-size', '10px').attr('font-family', 'JetBrains Mono, monospace').text('TIME →');
          g.append('text').attr('transform', 'rotate(-90)').attr('x', -iH / 2).attr('y', -50).attr('text-anchor', 'middle').attr('fill', '#94a3b8').attr('font-size', '10px').attr('font-family', 'JetBrains Mono, monospace').text('DURATION (µs)');

          // Legend
          profileSeries.forEach(({ label, color: col }, i) => {
               const lbl = `T-${selectedTid} ${label}`;
               svg.append('rect').attr('x', M.left + (i % 3) * 110).attr('y', 4 + Math.floor(i / 3) * 12).attr('width', 8).attr('height', 8).attr('rx', 2).attr('fill', col);
               svg.append('text').attr('x', M.left + (i % 3) * 110 + 12).attr('y', 12 + Math.floor(i / 3) * 12)
                    .attr('fill', '#cbd5e1').attr('font-size', '11px').text(lbl);
          });

          document.getElementById('profiler-meta').textContent =
               `Thread T-${selectedTid} · ${data.length} events · ${BINS} time bins`;
     }

     // ── Event Distribution Donut ──────────────────────────
     function renderEventDonut(data) {
          const container = document.getElementById('profiler-donut');
          container.innerHTML = '';

          const counts = d3.rollup(data, v => v.length, d => d.event);
          const W = Math.max(240, container.clientWidth || 240);
          const H = Math.max(240, container.clientHeight || 0);
          const radius = Math.max(44, Math.min(W, H) / 2 - 44);

          const pie = d3.pie().value(d => d[1]).sort(null);
          const arc = d3.arc().innerRadius(radius * 0.5).outerRadius(radius);

          const svg = d3.select(container).append('svg')
               .attr('width', W).attr('height', H)
               .attr('viewBox', `0 0 ${W} ${H}`)
               .style('width', '100%')
               .style('height', '100%');
          const g = svg.append('g').attr('transform', `translate(${W / 2},${H / 2 - 20})`);

          const arcs = g.selectAll('g').data(pie([...counts])).join('g');
          arcs.append('path').attr('d', arc)
               .attr('fill', d => EventBus.colors[d.data[0]] || '#888')
               .attr('stroke', 'rgba(0,0,0,0.3)')
               .style('cursor', 'pointer')
               .on('mouseover', (event, d) => {
                    const tooltip = document.getElementById('global-tooltip');
                    tooltip.classList.add('visible');
                    tooltip.innerHTML = `
                         <div class="tt-title">${EventBus.label(d.data[0])}</div>
                         <div class="tt-row"><span class="tt-key">Count</span><span class="tt-val">${d.data[1]}</span></div>
                         <div class="tt-row"><span class="tt-key">Share</span><span class="tt-val">${((d.data[1] / data.length) * 100).toFixed(1)}%</span></div>
                    `;
                    EventBus.positionTooltip(tooltip, event);
               })
               .on('mouseout', () => document.getElementById('global-tooltip').classList.remove('visible'));

          g.append('text').attr('text-anchor', 'middle').attr('dy', '-0.1em')
               .attr('fill', 'var(--cyan)').attr('font-family', "'Orbitron',monospace").attr('font-size', '0.95rem')
               .text(data.length);
          g.append('text').attr('text-anchor', 'middle').attr('dy', '1.2em')
               .attr('fill', 'var(--text-secondary)').attr('font-size', '11px').text('events');

          // Legend
          let ly = H - 10;
          const legG = svg.append('g');
          let i = 0;
          for (let [ev, cnt] of counts) {
               const col = EventBus.colors[ev] || '#888';
               const x = (i % 2) * (W / 2) + 10;
               const y = ly - Math.floor(i / 2) * 20;
               legG.append('rect').attr('x', x).attr('y', y - 7).attr('width', 7).attr('height', 7).attr('rx', 1).attr('fill', col);
               legG.append('text').attr('x', x + 10).attr('y', y)
                    .attr('fill', '#7aa0c4').attr('font-size', '10px')
                    .text(EventBus.label(ev).slice(0, 16) + ' (' + cnt + ')');
               i++;
          }
     }

     // ── Profiler Stats Cards ──────────────────────────────
     function renderProfilerStats(data) {
          let wait = 0, locks = 0, dl = 0, compute_explicit = 0;
          let minTs = Infinity, maxTs = -Infinity;
          // Accumulate total duration per event type
          const blocks = { COMPUTE: 0, SLEEP: 0, LOCK_WAIT: 0, COND_WAIT: 0, IO_WAIT: 0, THREAD_JOIN: 0 };

          data.forEach(d => {
               const startT = d.ts - (d.duration_us || 0);
               if (startT < minTs) minTs = startT;
               if (d.ts > maxTs) maxTs = d.ts;

               if (d.event === 'COMPUTE') compute_explicit += d.duration_us;
               else if (d.event === 'SLEEP' || d.event === 'IO_WAIT' || d.event === 'COND_WAIT' || d.event === 'LOCK_WAIT' || d.event === 'THREAD_JOIN') {
                    wait += d.duration_us;
               }
               if (blocks[d.event] !== undefined) blocks[d.event] += (d.duration_us || 0);

               if (d.event === 'LOCK_WAIT' || d.event === 'LOCK_ACQUIRE') locks++;
               if (d.event === 'DEADLOCK_DETECTED') dl++;
          });

          let span = maxTs - minTs;
          if (span <= 0 || !isFinite(span)) span = 1;

          // Use our unified EventBus colors
          const kpis = [
               { title: 'Compute', val: formatUs(blocks['COMPUTE']), color: EventBus.colors['COMPUTE'] },
               { title: 'Sleep', val: formatUs(blocks['SLEEP']), color: EventBus.colors['SLEEP'] },
               { title: 'Lock Wait', val: formatUs(blocks['LOCK_WAIT']), color: EventBus.colors['LOCK_WAIT'] },
               { title: 'Cond Wait', val: formatUs(blocks['COND_WAIT']), color: EventBus.colors['COND_WAIT'] },
               { title: 'I/O Wait', val: formatUs(blocks['IO_WAIT']), color: EventBus.colors['IO_WAIT'] },
               { title: 'Thread Join', val: formatUs(blocks['THREAD_JOIN']), color: EventBus.colors['THREAD_JOIN'] }
          ];

          const totalActive = blocks['COMPUTE'] + blocks['SLEEP'] + blocks['LOCK_WAIT'] + blocks['COND_WAIT'] + blocks['IO_WAIT'] + blocks['THREAD_JOIN'] || 1;
          const eff = ((blocks['COMPUTE'] / totalActive) * 100).toFixed(1);

          const kpiGrid = document.getElementById('profiler-stats-cards');
          if (kpiGrid) kpiGrid.innerHTML = kpis.map(k => `
            <div class="pf-kpi">
                <div class="pf-kpi-title" style="color:${k.color}">
                    <span class="legend-dot" style="background:${k.color}"></span>${k.title}
                </div>
                <div class="pf-kpi-val">${k.val}</div>
            </div>
        `).join('');
          const scoreCard = document.getElementById('profiler-score-card');
          if (scoreCard) scoreCard.innerHTML = `
            <div class="score-mini"><div class="sv" style="color:${+eff > 75 ? 'var(--green)' : +eff > 50 ? 'var(--amber)' : 'var(--red)'}">${eff}%</div><div class="sl">Efficiency</div></div>
            <div class="score-mini"><div class="sv" style="color:var(--red)">${formatUs(wait)}</div><div class="sl">Wait Time</div></div>
        `;
     }

     function bindBus() {
          EventBus.on('scenarioFilter', ({ scenario }) => {
               filteredData = scenario === 'all' ? allData : allData.filter(d => d.scenario === scenario);
               populateSelector();
          });
          EventBus.on('threadSelect', ({ tid }) => {
               if (tid === null) return;
               selectedTid = tid;
               const sel = document.getElementById('thread-selector');
               if (sel) sel.value = tid;
               if (document.getElementById('page-profiler').classList.contains('active')) renderProfiler();
          });
     }

     function triggerResize() {
          if (!allData.length) return;
          renderProfiler();
     }

     return { init, triggerResize };
})();
