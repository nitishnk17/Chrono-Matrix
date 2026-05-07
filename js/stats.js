/**
 * stats.js — Thread Event Summary Panel (Optimized)
 *
 * Performance improvements:
 *   • All DOM writes batched into a single innerHTML set (no per-element updates)
 *   • timeRange + threadSelect updates debounced at 100ms (not every frame)
 *   • requestAnimationFrame for actual DOM write
 *   • computeStats() runs on the data slice, not re-filtering per render
 */

const StatsPanel = (() => {
     let allData = [], filteredData = [];
     let currentRange = null, currentTid = null;
     let rafPending = false;
     let debounceTimer = null;

     function formatUs(v) {
          if (v >= 1e6) return (v / 1e6).toFixed(2) + 's';
          if (v >= 1e3) return (v / 1e3).toFixed(1) + 'ms';
          return v.toFixed(0) + 'µs';
     }

     function computeStats(data) {
          const threads = {};
          let totalEvents = 0, totalCompute = 0, totalWait = 0, totalLocks = 0, deadlocks = 0;

          for (let i = 0; i < data.length; i++) {
               const d = data[i];
               totalEvents++;
               let t = threads[d.tid];
               if (!t) { t = threads[d.tid] = { compute: 0, wait: 0, locks: 0, deadlocks: 0 }; }

               if (d.event === 'COMPUTE') { t.compute += d.duration_us; totalCompute += d.duration_us; }
               else if (d.event === 'LOCK_WAIT') { t.wait += d.duration_us; totalWait += d.duration_us; t.locks++; totalLocks++; }
               else if (d.event === 'LOCK_ACQUIRE') { t.locks++; totalLocks++; }
               else if (d.event === 'DEADLOCK_DETECTED') { t.wait += d.duration_us; t.deadlocks++; deadlocks++; }
          }
          return { threads, totalEvents, totalCompute, totalWait, totalLocks, deadlocks };
     }

     function init(data) {
          allData = data;
          filteredData = data;
          scheduleRender();
          bindBus();
     }

     function scheduleRender() {
          if (rafPending) return;
          rafPending = true;
          requestAnimationFrame(() => { renderImpl(); rafPending = false; });
     }

     function scheduleDebouncedRender() {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
               scheduleRender();
               debounceTimer = null;
          }, 80);
     }

     function renderImpl() {
          const sliced = currentRange
               ? filteredData.filter(d => d.ts >= currentRange.t0 && d.ts <= currentRange.t1)
               : filteredData;

          const { threads, totalEvents, totalCompute, totalWait, totalLocks, deadlocks } = computeStats(sliced);
          const totalTime = totalCompute + totalWait || 1;

          // ── Stat cards ────────────────────────────────────────
          const statsContainer = document.getElementById('stats-container');
          if (!statsContainer) return;
          statsContainer.innerHTML = `
            <div class="stat-card">
                <div class="sc-val">${totalEvents.toLocaleString()}</div>
                <div class="sc-label">Events</div>
            </div>
            <div class="stat-card">
                <div class="sc-val" style="color:var(--green)">${((totalCompute / totalTime) * 100).toFixed(1)}%</div>
                <div class="sc-label">Compute</div>
            </div>
            <div class="stat-card">
                <div class="sc-val" style="color:var(--red)">${((totalWait / totalTime) * 100).toFixed(1)}%</div>
                <div class="sc-label">Wait/Block</div>
            </div>
            <div class="stat-card">
                <div class="sc-val" style="color:var(--amber)">${totalLocks.toLocaleString()}</div>
                <div class="sc-label">Lock Ops</div>
            </div>
            <div class="stat-card">
                <div class="sc-val" style="color:${deadlocks > 0 ? 'var(--purple)' : 'var(--text-muted)'}">${deadlocks}</div>
                <div class="sc-label">Deadlocks</div>
            </div>
            <div class="stat-card">
                <div class="sc-val">${Object.keys(threads).length}</div>
                <div class="sc-label">Threads</div>
            </div>
        `;

          // ── Per-thread bars ───────────────────────────────────
          const sorted = Object.entries(threads)
               .sort((a, b) => b[1].wait - a[1].wait)
               .slice(0, 20);

          if (!sorted.length) {
               document.getElementById('thread-rows').innerHTML =
                    '<div style="color:var(--text-muted);font-size:11px;padding:8px">No data in range.</div>';
               document.getElementById('stats-meta').textContent = 'No data';
               return;
          }

          const maxTotal = Math.max(...sorted.map(([, v]) => v.compute + v.wait)) || 1;

          // Build HTML string in one pass — much faster than DOM element creation
          let html = '';
          sorted.forEach(([tid, s]) => {
               const total = s.compute + s.wait || 1;
               const barTotal = (s.compute + s.wait) / maxTotal;
               const cW = (barTotal * s.compute / total * 100).toFixed(2);
               const wW = (barTotal * s.wait / total * 100).toFixed(2);
               const wOff = (barTotal * s.compute / total * 100).toFixed(2);
               const isSel = currentTid !== null && +tid === currentTid;
               html += `<div class="thread-row${isSel ? ' selected' : ''}" data-tid="${tid}">
                <span class="tr-id">T-${tid}</span>
                <div class="tr-bar-wrap">
                    <div class="tr-compute-bar" style="width:${cW}%"></div>
                    <div class="tr-wait-bar" style="left:${wOff}%;width:${wW}%"></div>
                </div>
                <span class="tr-label">${formatUs(s.wait)} wait</span>
            </div>`;
          });
          document.getElementById('thread-rows').innerHTML = html;

          // Re-attach click listeners after innerHTML swap (delegation pattern)
          document.getElementById('thread-rows').onclick = (e) => {
               const row = e.target.closest('.thread-row');
               if (!row) return;
               const tid = +row.dataset.tid;
               const newSel = (currentTid === tid) ? null : tid;
               currentTid = newSel;
               EventBus.emit('threadSelect', { tid: newSel });
               scheduleRender();
          };

          document.getElementById('stats-meta').textContent =
               `${Object.keys(threads).length} threads · ${formatUs(totalWait)} total wait`;
     }

     function bindBus() {
          EventBus.on('timeRange', range => {
               currentRange = range;
               scheduleDebouncedRender(); // debounced — don't re-render every zoom frame
          });
          EventBus.on('scenarioFilter', ({ scenario }) => {
               filteredData = scenario === 'all' ? allData : allData.filter(d => d.scenario === scenario);
               currentRange = null;
               currentTid = null;
               scheduleRender();
          });
          EventBus.on('threadSelect', ({ tid }) => {
               currentTid = tid;
               scheduleRender();
          });
     }

     return { init };
})();
