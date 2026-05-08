/**
 * gantt.js — Canvas-based Thread Timeline (zero SVG rects)
 *
 * Architecture:
 *   • HTML Canvas for bars  → fillRect is ~100x faster than SVG attr updates
 *   • SVG overlay (pointer-events:none) for Y/X axes only
 *   • d3.zoom on canvas element for scroll-zoom + drag-pan
 *   • requestAnimationFrame batching — at most ONE draw per screen refresh
 *   • timeRange events throttled to 20fps so other views don't over-render
 *   • Overview strip (SVG brush) below for cross-view time filtering
 *   • Hit-test math on mousemove (O(n) scan culled to visible range)
 */

const GanttChart = (() => {
     const THROTTLE_MS = 50;  // 20fps max for cross-view timeRange updates

     const MAIN_MARGIN = { top: 8, right: 30, bottom: 28, left: 70 };
     const OVERVIEW_MARGIN = { top: 6, right: 30, bottom: 28, left: 70 };
     const OVERVIEW_H = 46;

     // State
     let allData = [], filteredData = [], displayData = [];
     let selectedThread = null;
     let tooltip;
     let innerW, innerH;
     let currentTransform = d3.zoomIdentity;
     let xBase, xAxisGroup, zoomBehavior;
     let yScale;

     // Canvas
     let canvas, ctx, dpr;

     // Overview
     let ovSvg, ovBrush, ovBrushGroup, xOv;

     // Event Filters — Birth/Death always shown, not toggleable
     let activeEventTypes = new Set(['COMPUTE', 'SLEEP', 'IO_WAIT', 'COND_WAIT', 'THREAD_JOIN', 'LOCK_ACQUIRE', 'LOCK_WAIT', 'LOCK_WAIT_TIMEOUT', 'LOCK_RELEASE', 'THREAD_START', 'THREAD_END', 'DEADLOCK_DETECTED', 'MEM_READ', 'MEM_WRITE', 'MEM_ALLOC', 'MEM_FREE']);

     // rAF
     let rafPending = false;

     // Throttle for cross-view emit
     let lastEmit = 0, emitTimer = null;
     let bindingEventFilters = false;
     let suppressTimeEmit = false;
     let syncingBrushFromZoom = false;

     // ── Helpers ──────────────────────────────────────────────
     let tOrigin = 0;  // set to min timestamp, so axis shows relative time
     function formatTimeUs(ts) {
          const rel = ts - tOrigin;
          if (rel >= 1e6) return (rel / 1e6).toFixed(2) + 's';
          if (rel >= 1e3) return (rel / 1e3).toFixed(1) + 'ms';
          return rel.toFixed(0) + 'µs';
     }

     function formatDurationUs(us) {
          if (us >= 1e6) return (us / 1e6).toFixed(2) + 's';
          if (us >= 1e3) return (us / 1e3).toFixed(1) + 'ms';
          return us.toFixed(0) + 'µs';
     }

     function eventStart(d) {
          if (d.event === 'LOCK_RELEASE' || d.event === 'THREAD_START' || d.event === 'THREAD_END' ||
               d.event === 'MEM_READ' || d.event === 'MEM_WRITE' || d.event === 'MEM_ALLOC' || d.event === 'MEM_FREE') {
               return d.ts;
          }
          return d.ts - Math.max(0, d.duration_us || 0);
     }

     function syncFilterPills() {
          document.querySelectorAll('.ev-chk').forEach(chk => {
               const isActive = activeEventTypes.has(chk.dataset.ev);
               chk.classList.toggle('inactive', !isActive);
               chk.style.opacity = isActive ? '1.0' : '0.38';
          });
     }

     function bindEventFiltersOnce() {
          if (bindingEventFilters) return;
          bindingEventFilters = true;
          document.querySelectorAll('.ev-chk').forEach(chk => {
               chk.addEventListener('click', () => {
                    const evType = chk.dataset.ev;
                    if (activeEventTypes.has(evType)) activeEventTypes.delete(evType);
                    else activeEventTypes.add(evType);
                    syncFilterPills();
                    render();
               });
          });
     }

     function throttledEmitTimeRange(val) {
          const now = Date.now();
          if (now - lastEmit >= THROTTLE_MS) {
               lastEmit = now;
               EventBus.emit('timeRange', val);
          } else {
               if (emitTimer) clearTimeout(emitTimer);
               emitTimer = setTimeout(() => {
                    lastEmit = Date.now();
                    EventBus.emit('timeRange', val);
                    emitTimer = null;
               }, THROTTLE_MS - (now - lastEmit));
          }
     }

     // ── Init ──────────────────────────────────────────────────
     function init(data, tooltipEl) {
          allData = data;
          filteredData = data;
          displayData = data;
          tooltip = tooltipEl;
          bindEventFiltersOnce();
          render();
          bindBus();
     }

     // ── Full render (called on init + filter change) ──────────
     function render() {
          currentTransform = d3.zoomIdentity;
          const container = document.getElementById('gantt-chart');
          container.innerHTML = '';

          // Apply event type filtering
          const renderingData = displayData.filter(d => activeEventTypes.has(d.event));

          const threads = [...new Set(renderingData.map(d => d.tid))].sort((a, b) => a - b);
          if (!threads.length) { container.innerHTML = '<div style="color:var(--text-muted);padding:20px">No matching event data.</div>'; return; }

          const W = container.clientWidth || 1200;
          const availableH = Math.max(560, container.clientHeight || 0);
          const rowH = Math.max(18, Math.min(34, Math.floor((availableH - MAIN_MARGIN.top - MAIN_MARGIN.bottom - OVERVIEW_H - OVERVIEW_MARGIN.top - OVERVIEW_MARGIN.bottom) / Math.max(1, threads.length))));
          innerH = threads.length * rowH;
          innerW = W - MAIN_MARGIN.left - MAIN_MARGIN.right;
          const mainH = innerH + MAIN_MARGIN.top + MAIN_MARGIN.bottom;
          const ovH = OVERVIEW_H + OVERVIEW_MARGIN.top + OVERVIEW_MARGIN.bottom;

          const timeExtent = [
               d3.min(displayData, d => eventStart(d)) ?? d3.min(displayData, d => d.ts),
               d3.max(displayData, d => d.ts)
          ];
          tOrigin = timeExtent[0] || 0;
          xBase = d3.scaleLinear().domain(timeExtent).range([0, innerW]);
          xOv = d3.scaleLinear().domain(timeExtent).range([0, innerW]);
          yScale = d3.scaleBand().domain(threads.map(String)).range([0, innerH]).padding(0.12);

          // ── Wrapper div ───────────────────────────────────────
          const wrap = document.createElement('div');
          wrap.style.cssText = `position:relative;width:${W}px;height:${mainH}px;`;
          container.appendChild(wrap);

          // ── Canvas ────────────────────────────────────────────
          dpr = window.devicePixelRatio || 1;
          canvas = document.createElement('canvas');
          canvas.width = innerW * dpr;
          canvas.height = innerH * dpr;
          canvas.style.cssText = `position:absolute;top:${MAIN_MARGIN.top}px;left:${MAIN_MARGIN.left}px;width:${innerW}px;height:${innerH}px;cursor:grab;`;
          ctx = canvas.getContext('2d');
          ctx.scale(dpr, dpr);
          wrap.appendChild(canvas);

          // ── Axes SVG overlay ──────────────────────────────────
          const axesSvg = d3.select(wrap).append('svg')
               .attr('width', W).attr('height', mainH)
               .style('position', 'absolute').style('top', 0).style('left', 0)
               .style('pointer-events', 'none').style('overflow', 'visible');

          // Y axis (static — never changes with zoom)
          axesSvg.append('g').attr('class', 'axis')
               .attr('transform', `translate(${MAIN_MARGIN.left},${MAIN_MARGIN.top})`)
               .call(d3.axisLeft(yScale).tickFormat(d => 'T-' + d));



          // X axis (updated on zoom)
          xAxisGroup = axesSvg.append('g').attr('class', 'axis')
               .attr('transform', `translate(${MAIN_MARGIN.left},${MAIN_MARGIN.top + innerH})`);
          refreshXAxis(xBase);

          axesSvg.append('text').attr('class','axis-lbl').attr('x', MAIN_MARGIN.left + innerW/2).attr('y', MAIN_MARGIN.top + innerH + 24).attr('text-anchor','middle').attr('fill','#94a3b8').attr('font-size','10px').attr('font-family','JetBrains Mono, monospace').text('TRACE TIME →');

          // ── Zoom ─────────────────────────────────────────────
          zoomBehavior = d3.zoom()
               .scaleExtent([0.5, 2000])
               .translateExtent([[-innerW * 0.5, 0], [innerW * 1.5, innerH]])
               .extent([[0, 0], [innerW, innerH]])
               .on('zoom', onZoom)
               .on('start', () => canvas.style.cursor = 'grabbing')
               .on('end', () => canvas.style.cursor = 'grab');

          d3.select(canvas).call(zoomBehavior);
          d3.select(canvas).on('dblclick.zoom', null).on('dblclick', resetZoom);

          // Mouse interactions
          d3.select(canvas)
               .on('mousemove', onCanvasMouseMove)
               .on('mouseleave', () => tooltip.classList.remove('visible'))
               .on('click', onCanvasClick);

          // ── Overview strip ────────────────────────────────────
          ovSvg = d3.select(container).append('svg')
               .attr('width', W).attr('height', ovH)
               .style('display', 'block');

          const ovG = ovSvg.append('g').attr('transform', `translate(${OVERVIEW_MARGIN.left},${OVERVIEW_MARGIN.top})`);
          const ovInH = OVERVIEW_H - 2;

          // Tiny overview bars
          ovG.selectAll('.ov-b').data(displayData).join('rect').attr('class', 'ov-b')
               .attr('x', d => xOv(d.ts))
               .attr('y', d => { const y = yScale(String(d.tid)); return y !== undefined ? y / innerH * ovInH : 0; })
               .attr('width', d => Math.max(0.8, xOv(d.ts + d.duration_us) - xOv(d.ts)))
               .attr('height', 2)
               .attr('fill', d => EventBus.colors[d.event] || '#888')
               .attr('opacity', 0.55);

          ovG.append('g').attr('class', 'axis')
               .attr('transform', `translate(0,${ovInH})`)
               .call(d3.axisBottom(xOv).ticks(6).tickFormat(formatTimeUs));

          ovG.append('text')
               .attr('x', innerW / 2).attr('y', ovInH + 24)
               .attr('text-anchor', 'middle').attr('fill', '#475569').attr('font-size', '10px')
               .attr('font-family', "'IBM Plex Mono', monospace")
               .text('brush to filter  ·  scroll to zoom  ·  double-click to reset');

          ovBrush = d3.brushX()
               .extent([[0, 0], [innerW, ovInH]])
               .on('brush end', onOverviewBrush);

          ovBrushGroup = ovG.append('g').attr('class', 'brush').call(ovBrush);

          syncFilterPills();

          // ── First draw ────────────────────────────────────────
          scheduleRedraw();
          updateGanttMeta(threads.length);
     }

     // ── Canvas draw (called via rAF) ──────────────────────────
     function drawBars() {
          ctx.clearRect(0, 0, innerW, innerH);

          const tx = currentTransform.x;
          const tk = currentTransform.k;

          // Visible data domain for culling
          const visT0 = xBase.invert(-tx / tk);
          const visT1 = xBase.invert((innerW - tx) / tk);

          // --- Grid lines first (behind bars) ---
          const rescaled = currentTransform.rescaleX(xBase);
          ctx.strokeStyle = 'rgba(0,245,255,0.07)';
          ctx.setLineDash([3, 4]);
          ctx.lineWidth = 0.5;
          rescaled.ticks(8).forEach(t => {
               const px = tx + xBase(t) * tk;
               if (px < -2 || px > innerW + 2) return;
               ctx.beginPath();
               ctx.moveTo(px, 0);
               ctx.lineTo(px, innerH);
               ctx.stroke();
          });
          ctx.setLineDash([]);

          // --- Bars ---
          // Pre-filter memory once on initialization or checkbox toggle, assuming `displayData` is sorted by `ts`.
          const renderingData = displayData.filter(d => activeEventTypes.has(d.event));

          if (renderingData.length === 0) {
               ctx.globalAlpha = 1.0;
               return;
          }

          // BINARY SEARCH (O(log N)): Find the start and end indices of data perfectly visible inside this viewport.
          // Because `d.ts` is the *end* time of an event, we need to be slightly generous on the start bound.
          // We will search for events ending after or exactly at `visT0`, minus some fudge for extremely long events.
          const bisectData = d3.bisector(d => d.ts).left;

          // Back up the search bound by the longest visible duration so long events are not clipped out.
          const maxExpectedEventDurationUs = Math.max(1, d3.max(renderingData, d => d.duration_us) || 0);
          let startIndex = bisectData(renderingData, Math.max(0, visT0 - maxExpectedEventDurationUs));
          let endIndex = bisectData(renderingData, visT1 + maxExpectedEventDurationUs);

          for (let i = startIndex; i <= endIndex && i < renderingData.length; i++) {
               const d = renderingData[i];

               // The backend logs events exactly when they FINISH, meaning `ts` is the end time
               // and `duration_us` is how long it took entirely in the past. 
               let startT = eventStart(d);
               if (startT === d.ts) startT = d.ts - 1;

               // Strict Culling: If event mathematically completely falls outside of [visT0, visT1], skip draw.
               if (d.ts < visT0 || startT > visT1) continue;

               const yBand = yScale(String(d.tid));
               if (yBand === undefined) continue;

               const xStart = tx + xBase(startT) * tk;
               const xEnd = tx + xBase(d.ts) * tk;

               // Guarantee at least 1.5px width for visibility, drawn backward from xEnd
               const w = Math.max(1.5, xEnd - xStart);
               const x = xEnd - w;
               const y = yBand + 2;
               const h = yScale.bandwidth() - 4;

               ctx.globalAlpha = (selectedThread !== null && d.tid !== selectedThread) ? 0.1 : 1.0;
               ctx.fillStyle = EventBus.colors[d.event] || '#888';
               ctx.fillRect(x, y, w, h);
          }
          ctx.globalAlpha = 1.0;
     }

     function scheduleRedraw() {
          if (rafPending) return;
          rafPending = true;
          requestAnimationFrame(() => { drawBars(); rafPending = false; });
     }

     function refreshXAxis(scl) {
          xAxisGroup.call(d3.axisBottom(scl).ticks(8).tickFormat(formatTimeUs));
     }

     // ── Zoom handler ──────────────────────────────────────────
     function onZoom(event) {
          currentTransform = event.transform;
          scheduleRedraw();                          // canvas redraws at 60fps
          refreshXAxis(currentTransform.rescaleX(xBase)); // axis SVG is lightweight
          const rescaled = currentTransform.rescaleX(xBase);
          const t0 = rescaled.invert(0), t1 = rescaled.invert(innerW);
          if (!suppressTimeEmit) throttledEmitTimeRange({ t0, t1 });
          if (ovBrushGroup && xOv) {
               const sel = [Math.max(0, xOv(t0)), Math.min(innerW, xOv(t1))];
               syncingBrushFromZoom = true;
               if (sel[0] < sel[1] - 1) ovBrushGroup.call(ovBrush.move, sel);
               syncingBrushFromZoom = false;
          }
     }

     // ── Overview brush handler ─────────────────────────────────
     function onOverviewBrush(event) {
          if (syncingBrushFromZoom) return;
          if (!event.selection) {
               EventBus.emit('timeRange', null);
               return;
          }
          const [px0, px1] = event.selection;
          const t0 = xOv.invert(px0), t1 = xOv.invert(px1);
          EventBus.emit('timeRange', { t0, t1 });
          // Zoom main chart to brush range
          const zoomK = innerW / (px1 - px0);
          const zoomTx = -px0 * zoomK;
          const t = d3.zoomIdentity.scale(zoomK).translate(zoomTx / zoomK, 0);
          d3.select(canvas).call(zoomBehavior.transform, t);
     }

     function resetZoom() {
          d3.select(canvas).call(zoomBehavior.transform, d3.zoomIdentity);
          if (ovBrushGroup) ovBrushGroup.call(ovBrush.move, null);
          EventBus.emit('timeRange', null);
     }

     // ── Hit testing ───────────────────────────────────────────
     function hitTest(clientX, clientY) {
          const rect = canvas.getBoundingClientRect();
          const mx = clientX - rect.left;
          const my = clientY - rect.top;
          const dataX = (mx - currentTransform.x) / currentTransform.k;
          const dataT = xBase.invert(dataX);

          const tidStr = yScale.domain().find(t => {
               const y0 = yScale(t);
               return my >= y0 && my < y0 + yScale.bandwidth();
          });
          if (!tidStr) return null;

          const tidNum = +tidStr;

          // minimum selectable width in data units
          const minW = 1.5 / currentTransform.k;

          let bestMatch = null;
          let minDur = Infinity;

          const renderingData = displayData.filter(d => activeEventTypes.has(d.event));

          for (let i = 0; i < renderingData.length; i++) {
               const d = renderingData[i];
               if (d.tid === tidNum) {
                    const startT = eventStart(d);
                    // Mouse is between the retrospective start and the logged end of the event
                    if (dataT >= startT && dataT <= d.ts + minW) {
                         if (d.duration_us < minDur) {
                              bestMatch = d;
                              minDur = d.duration_us;
                         }
                    }
               }
          }
          return bestMatch;
     }

     function onCanvasMouseMove(event) {
          const bar = hitTest(event.clientX, event.clientY);
          if (bar) {
               tooltip.classList.add('visible');
               tooltip.innerHTML = `
                <div class="tt-title">${bar.event}</div>
                <div class="tt-row"><span class="tt-key">Thread</span><span class="tt-val">T-${bar.tid}</span></div>
                <div class="tt-row"><span class="tt-key">Resource</span><span class="tt-val">${bar.resource}</span></div>
                <div class="tt-row"><span class="tt-key">Addr</span><span class="tt-val">${bar.addr}</span></div>
                ${bar.size ? `<div class="tt-row"><span class="tt-key">Size</span><span class="tt-val">${bar.size} B</span></div>` : ''}
                <div class="tt-row"><span class="tt-key">Duration</span><span class="tt-val">${formatDurationUs(bar.duration_us)}</span></div>
                <div class="tt-row"><span class="tt-key">Scenario</span><span class="tt-val">${(bar.scenario || 'uncategorized').replace(/_/g, ' ')}</span></div>
            `;
               EventBus.positionTooltip(tooltip, event);
          } else {
               tooltip.classList.remove('visible');
          }
     }

     function onCanvasClick(event) {
          const bar = hitTest(event.clientX, event.clientY);
          const newSel = (bar && selectedThread !== bar.tid) ? bar.tid : null;
          if (newSel !== selectedThread) {
               selectedThread = newSel;
               EventBus.emit('threadSelect', { tid: selectedThread });
               scheduleRedraw();
          }
     }

     // ── Filter update ─────────────────────────────────────────
     function updateFilter(scenario) {
          filteredData = scenario === 'all' ? allData : allData.filter(d => d.scenario === scenario);
          displayData = filteredData;
          selectedThread = null;
          render();
     }

     function applyExternalTimeRange(range) {
          if (!canvas || !zoomBehavior || !xOv || !innerW) return;
          suppressTimeEmit = true;
          if (!range) {
               d3.select(canvas).call(zoomBehavior.transform, d3.zoomIdentity);
               if (ovBrushGroup) ovBrushGroup.call(ovBrush.move, null);
               suppressTimeEmit = false;
               return;
          }

          const domain = xBase.domain();
          const t0 = Math.max(domain[0], Math.min(domain[1], range.t0));
          const t1 = Math.max(domain[0], Math.min(domain[1], range.t1));
          const px0 = Math.max(0, xOv(Math.min(t0, t1)));
          const px1 = Math.min(innerW, xOv(Math.max(t0, t1)));
          if (px1 <= px0 + 1) {
               suppressTimeEmit = false;
               return;
          }
          const zoomK = innerW / (px1 - px0);
          const zoomTx = -px0 * zoomK;
          const t = d3.zoomIdentity.scale(zoomK).translate(zoomTx / zoomK, 0);
          d3.select(canvas).call(zoomBehavior.transform, t);
          if (ovBrushGroup) ovBrushGroup.call(ovBrush.move, [px0, px1]);
          suppressTimeEmit = false;
     }

     function applyThreadHighlight(tid) {
          selectedThread = tid;
          scheduleRedraw();
     }

     function updateGanttMeta(threadCount) {
          const renderingData = displayData.filter(d => activeEventTypes.has(d.event));
          document.getElementById('gantt-meta').textContent =
               `${renderingData.length.toLocaleString()} events · ${threadCount} threads displayed`;
     }

     // ── EventBus bindings ─────────────────────────────────────
     function bindBus() {
          EventBus.on('scenarioFilter', ({ scenario }) => updateFilter(scenario));
          EventBus.on('threadSelect', ({ tid }) => applyThreadHighlight(tid));
          EventBus.on('timeRange', range => applyExternalTimeRange(range));
     }

     function triggerResize() {
          if (!allData.length) return;
          render();
     }

     return { init, updateFilter, triggerResize };
})();
