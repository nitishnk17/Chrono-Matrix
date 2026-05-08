/**
 * heatmap.js — Canvas-based Memory Contention Heatmap
 *
 * Performance: 1440 fillRect calls on Canvas vs 1440 SVG <rect> elements.
 *   Canvas version redraws in ~1ms; SVG version caused 15–40ms render blocks.
 *
 * Layout:
 *   • <canvas> for cells
 *   • <svg> overlay for axes (pointer-events:none)
 *   • Mouse events on canvas for O(1) hit-test
 */

const HeatmapChart = (() => {
     const TIME_BINS = 60;
     const ADDR_BINS = 24;
     const MARGIN = { top: 10, right: 20, bottom: 85, left: 90 };

     const TRACKED_EVENTS = new Set([
          'LOCK_WAIT', 'DEADLOCK_DETECTED', 'LOCK_ACQUIRE',
          'MEM_READ', 'MEM_WRITE', 'MEM_ALLOC', 'MEM_FREE'
     ]);

     let allData = [], filteredData = [];
     let tooltip;
     let rafPending = false;

     // Persistent canvas refs (recreated only on scenario change, not on timeRange)
     let canvas, ctx, dpr, innerW, innerH, cellW, cellH;
     let matrix = null, waitMatrix = null, sizeMatrix = null;
     let tMin, tMax;

     function formatUs(v) {
          if (v >= 1e6) return (v / 1e6).toFixed(2) + 's';
          if (v >= 1e3) return (v / 1e3).toFixed(1) + 'ms';
          return v.toFixed(0) + 'µs';
     }

     function addrBucket(addr) {
          if (typeof addr !== 'string' || !/^0x[0-9a-f]+$/i.test(addr)) return null;
          const v = parseInt(addr, 16);
          const min = 0xAA001000, max = 0xCC003080;
          const t = Math.max(0, Math.min(1, (v - min) / (max - min)));
          return Math.min(ADDR_BINS - 1, Math.floor(t * ADDR_BINS));
     }

     function addrLabel(i) {
          const v = 0xAA001000 + Math.floor(i * (0xCC003080 - 0xAA001000) / ADDR_BINS);
          return '0x' + v.toString(16).toUpperCase().padStart(8, '0');
     }

     // Build full matrix from data (expensive, only on scenario change)
     function buildMatrix(data) {
          const te = d3.extent(data, d => d.ts);
          tMin = te[0]; tMax = te[1];
          const tRange = tMax - tMin || 1;

          const mat = Array.from({ length: ADDR_BINS }, () => new Int32Array(TIME_BINS));
          const wMat = Array.from({ length: ADDR_BINS }, () => new Float64Array(TIME_BINS));
          const sMat = Array.from({ length: ADDR_BINS }, () => new Float64Array(TIME_BINS));

          data.forEach(d => {
               if (!TRACKED_EVENTS.has(d.event)) return;
               const ab = addrBucket(d.addr);
               if (ab === null) return;
               const tb = Math.min(TIME_BINS - 1, Math.floor(((d.ts - tMin) / tRange) * TIME_BINS));
               mat[ab][tb]++;
               if (d.event === 'LOCK_WAIT' || d.event === 'DEADLOCK_DETECTED')
                    wMat[ab][tb] += d.duration_us;
               if (d.event === 'MEM_READ' || d.event === 'MEM_WRITE' || d.event === 'MEM_ALLOC' || d.event === 'MEM_FREE')
                    sMat[ab][tb] += Math.max(0, Number(d.size) || 0);
          });

          return { mat, wMat, sMat };
     }

     // Build partial matrix for a time window (fast, for timeRange updates)
     function buildMatrixSlice(data, t0, t1) {
          const sliced = data.filter(d => d.ts >= t0 && d.ts <= t1);
          if (!sliced.length) return buildMatrix(data); // fallback
          return buildMatrix(sliced);
     }

     // ── Init ──────────────────────────────────────────────────
     function init(data, tooltipEl) {
          allData = data;
          filteredData = data;
          tooltip = tooltipEl;
          buildAndRenderFull();
          bindBus();
     }

     // ── Full setup (scenario change: recreates canvas+axes) ───
     function buildAndRenderFull(timeRange) {
          const container = document.getElementById('heatmap-chart');
          container.innerHTML = '';

          const W = Math.max(360, container.clientWidth || 560);
          const H = Math.max(520, container.clientHeight || 0);
          innerW = Math.max(1, W - MARGIN.left - MARGIN.right);
          innerH = Math.max(1, H - MARGIN.top - MARGIN.bottom);
          cellW = innerW / TIME_BINS;
          cellH = innerH / ADDR_BINS;

          const data = (timeRange && filteredData.length)
               ? filteredData.filter(d => d.ts >= timeRange.t0 && d.ts <= timeRange.t1)
               : filteredData;

          const built = buildMatrix(data.length ? data : filteredData);
          matrix = built.mat;
          waitMatrix = built.wMat;
          sizeMatrix = built.sMat;

          // ── Wrapper ───────────────────────────────────────────
          const wrap = document.createElement('div');
          wrap.style.cssText = `position:relative;width:${W}px;height:${H}px;`;
          container.appendChild(wrap);

          // ── Canvas ────────────────────────────────────────────
          dpr = window.devicePixelRatio || 1;
          canvas = document.createElement('canvas');
          canvas.width = innerW * dpr;
          canvas.height = innerH * dpr;
          canvas.style.cssText = `position:absolute;top:${MARGIN.top}px;left:${MARGIN.left}px;width:${innerW}px;height:${innerH}px;`;
          ctx = canvas.getContext('2d');
          ctx.scale(dpr, dpr);
          wrap.appendChild(canvas);

          // ── Axes SVG overlay ──────────────────────────────────
          const svg = d3.select(wrap).append('svg')
               .attr('width', W).attr('height', H)
               .style('position', 'absolute').style('top', 0).style('left', 0)
               .style('pointer-events', 'none');

          const g = svg.append('g').attr('transform', `translate(${MARGIN.left},${MARGIN.top})`);

          const xScl = d3.scaleLinear().domain([0, TIME_BINS]).range([0, innerW]);
          const yScl = d3.scaleLinear().domain([0, ADDR_BINS]).range([0, innerH]);

          g.append('g').attr('class', 'axis').attr('transform', `translate(0,${innerH})`)
               .call(d3.axisBottom(xScl).ticks(6).tickFormat(i => {
                    const t = (i / TIME_BINS) * (tMax - tMin);  // relative offset from trace start
                    return formatUs(t);
               }));

          g.append('g').attr('class', 'axis')
               .call(d3.axisLeft(yScl).ticks(6).tickFormat(i => addrLabel(Math.round(i))));

          g.append('text').attr('x', innerW / 2).attr('y', innerH + 42)
               .attr('text-anchor', 'middle').attr('fill', '#7aa0c4').attr('font-size', '12px')
               .text('TIME →');

          g.append('text').attr('transform', 'rotate(-90)')
               .attr('x', -innerH / 2).attr('y', -78)
               .attr('text-anchor', 'middle').attr('fill', '#7aa0c4').attr('font-size', '12px')
               .text('ADDR (hex)');

          // Colour gradient legend
          const defs = svg.append('defs');
          const grd = defs.append('linearGradient').attr('id', 'hm-grad').attr('x1', '0%').attr('x2', '100%');
          grd.append('stop').attr('offset', '0%').attr('stop-color', '#0d1b33');
          grd.append('stop').attr('offset', '100%').attr('stop-color', '#e53935');
          const legG = g.append('g').attr('transform', `translate(${innerW - 140},${innerH + 58})`);
          legG.append('rect').attr('width', 140).attr('height', 8).attr('fill', 'url(#hm-grad)');
          legG.append('text').attr('y', -3).attr('fill', '#7aa0c4').attr('font-size', '11px').text('0');
          const maxVal = d3.max(matrix.flatMap(r => [...r])) || 1;
          legG.append('text').attr('x', 140).attr('y', -3).attr('text-anchor', 'end')
               .attr('fill', '#7aa0c4').attr('font-size', '11px').text(maxVal + ' events');

          // ── Mouse tooltip ─────────────────────────────────────
          canvas.addEventListener('mousemove', (e) => {
               const r = canvas.getBoundingClientRect();
               const mx = e.clientX - r.left;
               const my = e.clientY - r.top;
               const ti = Math.max(0, Math.min(TIME_BINS - 1, Math.floor(mx / cellW)));
               const ai = Math.max(0, Math.min(ADDR_BINS - 1, Math.floor(my / cellH)));
               const val = matrix[ai][ti];
               if (!val) { tooltip.classList.remove('visible'); return; }
               const tStart = tMin + (ti / TIME_BINS) * (tMax - tMin);
               const tEnd = tMin + ((ti + 1) / TIME_BINS) * (tMax - tMin);
               const waitVal = waitMatrix?.[ai]?.[ti] || 0;
               const sizeVal = sizeMatrix?.[ai]?.[ti] || 0;
               tooltip.classList.add('visible');
               tooltip.innerHTML = `
                <div class="tt-title">CONTENTION CELL</div>
                <div class="tt-row"><span class="tt-key">Addr bin</span><span class="tt-val">${addrLabel(ai)} - ${addrLabel(Math.min(ADDR_BINS - 1, ai + 1))}</span></div>
                <div class="tt-row"><span class="tt-key">Time window</span><span class="tt-val">${formatUs(tStart - tMin)} - ${formatUs(tEnd - tMin)}</span></div>
                <div class="tt-row"><span class="tt-key">Events</span><span class="tt-val">${val}</span></div>
                ${waitVal > 0 ? `<div class="tt-row"><span class="tt-key">Wait</span><span class="tt-val">${formatUs(waitVal)}</span></div>` : ''}
                ${sizeVal > 0 ? `<div class="tt-row"><span class="tt-key">Bytes</span><span class="tt-val">${sizeVal.toLocaleString()}</span></div>` : ''}
            `;
               tooltip.style.left = Math.min(e.clientX + 14, window.innerWidth - 280) + 'px';
               tooltip.style.top = Math.max(e.clientY - 10, 10) + 'px';
          });
          canvas.addEventListener('mouseleave', () => tooltip.classList.remove('visible'));

          // Draw
          scheduleRedraw();
          updateHeatmapMeta();
     }

     // ── Canvas draw (rAF) ─────────────────────────────────────
     function drawCells() {
          if (!matrix || !ctx) return;
          const maxVal = d3.max(matrix.flatMap(r => [...r])) || 1;

          ctx.clearRect(0, 0, innerW, innerH);

          for (let ai = 0; ai < ADDR_BINS; ai++) {
               for (let ti = 0; ti < TIME_BINS; ti++) {
                    const val = matrix[ai][ti];
                    if (!val) continue;
                    const t = val / maxVal;
                    // Custom color: dark blue → cyan → red
                    ctx.fillStyle = d3.interpolateRgb('#0d1b33', '#e53935')(t);
                    ctx.fillRect(ti * cellW, ai * cellH, Math.max(cellW - 0.5, 1), Math.max(cellH - 0.5, 1));
               }
          }
     }

     function scheduleRedraw() {
          if (rafPending) return;
          rafPending = true;
          requestAnimationFrame(() => { drawCells(); rafPending = false; });
     }

     // ── Light timeRange update (no DOM rebuild, just redraw matrix) ──
     let debounceTimer = null;
     function onTimeRange(range) {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
               const data = range
                    ? filteredData.filter(d => d.ts >= range.t0 && d.ts <= range.t1)
                    : filteredData;
               const built = buildMatrix(data.length ? data : filteredData);
               matrix = built.mat;
               waitMatrix = built.wMat;
               sizeMatrix = built.sMat;
               scheduleRedraw();
               updateHeatmapMeta();
               debounceTimer = null;
          }, 80); // 80ms debounce — prevents rapid fire from zoom
     }

     function updateHeatmapMeta() {
          const total = matrix ? matrix.reduce((s, r) => s + r.reduce((a, b) => a + b, 0), 0) : 0;
          document.getElementById('heatmap-meta').textContent =
               `${total.toLocaleString()} tracked events · ${TIME_BINS}×${ADDR_BINS} grid`;
     }

     // ── Address Ranking Chart (Memory page sidebar) ───────
     function renderAddrRanking() {
          const container = document.getElementById('addr-rank-chart');
          if (!container) return;
          container.innerHTML = '';

          if (!matrix) return;
          const addrTotals = matrix.map((row, ai) => ({
               addr: addrLabel(ai),
               total: row.reduce((s, v) => s + v, 0)
          })).filter(d => d.total > 0).sort((a, b) => b.total - a.total).slice(0, 12);

          if (!addrTotals.length) { container.innerHTML = '<div style="color:var(--text-muted);padding:12px">No data.</div>'; return; }

          const W = Math.max(260, container.clientWidth || 240);
          const H = Math.max(addrTotals.length * 28 + 40, container.clientHeight || 0);
          const M = { top: 8, right: 50, bottom: 20, left: 80 };
          const iW = Math.max(1, W - M.left - M.right), iH = Math.max(1, H - M.top - M.bottom);

          const yScl = d3.scaleBand().domain(addrTotals.map(d => d.addr)).range([0, iH]).padding(0.2);
          const xScl = d3.scaleLinear().domain([0, addrTotals[0].total]).range([0, iW]).nice();

          const svg = d3.select(container).append('svg')
               .attr('width', W).attr('height', H)
               .attr('viewBox', `0 0 ${W} ${H}`)
               .style('width', '100%')
               .style('height', '100%');
          const g = svg.append('g').attr('transform', `translate(${M.left},${M.top})`);

          const colorScale = d3.scaleSequential().domain([0, addrTotals[0].total]).interpolator(d3.interpolateRgb('#0d3355', '#e53935'));

          g.selectAll('.ar-bar').data(addrTotals).join('rect').attr('class', 'ar-bar')
               .attr('y', d => yScl(d.addr)).attr('height', yScl.bandwidth()).attr('rx', 3)
               .attr('fill', d => colorScale(d.total))
               .attr('x', 0).attr('width', 0)
               .transition().duration(400).delay((_, i) => i * 30)
               .attr('width', d => Math.max(2, xScl(d.total)));

          g.selectAll('.ar-lbl').data(addrTotals).join('text').attr('class', 'ar-lbl')
               .attr('x', d => xScl(d.total) + 4)
               .attr('y', d => yScl(d.addr) + yScl.bandwidth() / 2)
               .attr('dy', '0.35em').attr('fill', 'var(--text-secondary)').attr('font-size', '11px')
               .attr('font-family', "'JetBrains Mono',monospace").text(d => d.total);

          g.append('g').attr('class', 'axis').call(d3.axisLeft(yScl).tickFormat(d => d.length > 9 ? '…' + d.slice(-7) : d));
          g.append('g').attr('class', 'axis').attr('transform', `translate(0,${iH})`).call(d3.axisBottom(xScl).ticks(3));

          g.append('text').attr('x', iW / 2).attr('y', iH + 32).attr('text-anchor', 'middle').attr('fill', '#94a3b8').attr('font-size', '10px').attr('font-family', 'JetBrains Mono, monospace').text('EVENTS');
     }

     function bindBus() {
          EventBus.on('timeRange', range => { onTimeRange(range); setTimeout(renderAddrRanking, 100); });
          EventBus.on('scenarioFilter', ({ scenario }) => {
               filteredData = scenario === 'all' ? allData : allData.filter(d => d.scenario === scenario);
               buildAndRenderFull(null);
               setTimeout(renderAddrRanking, 100);
          });
     }

     return {
          init,
          renderAddrRanking,
          triggerResize: () => {
               if (!allData.length) return;
               buildAndRenderFull(null);
               renderAddrRanking();
          }
     };
})();
