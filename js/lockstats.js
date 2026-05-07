/**
 * lockstats.js — Contention Page: Mutex Waterfall + Lock Ranking Table
 */

const LockStats = (() => {
     let allData = [], filteredData = [];

     function formatUs(v) {
          if (v >= 1e6) return (v / 1e6).toFixed(2) + 's';
          if (v >= 1e3) return (v / 1e3).toFixed(1) + 'ms';
          return v.toFixed(0) + 'µs';
     }

     function buildLockStats(data) {
          const stats = {};
          data.forEach(d => {
               if (d.event === 'LOCK_WAIT' || d.event === 'LOCK_ACQUIRE' || d.event === 'DEADLOCK_DETECTED' ||
                    d.event === 'COND_WAIT' || d.event === 'IO_WAIT' || d.event === 'THREAD_JOIN') {

                    if (!stats[d.resource]) stats[d.resource] = { wait: 0, acquires: 0, deadlocks: 0, threads: new Set() };
                    const s = stats[d.resource];

                    if (d.event === 'LOCK_WAIT' || d.event === 'COND_WAIT' || d.event === 'IO_WAIT' || d.event === 'THREAD_JOIN') {
                         s.wait += d.duration_us;
                         s.acquires++;
                    }
                    if (d.event === 'LOCK_ACQUIRE') s.acquires++;
                    if (d.event === 'DEADLOCK_DETECTED') s.deadlocks++;
                    s.threads.add(d.tid);
               }
          });
          return Object.entries(stats)
               .map(([res, s]) => ({ resource: res, wait: s.wait, acquires: s.acquires, deadlocks: s.deadlocks, threads: s.threads.size }))
               .sort((a, b) => b.wait - a.wait);
     }

     function init(data) {
          allData = data;
          filteredData = data;
          renderAll();
          bindBus();
     }

     function renderAll() {
          renderWaterfall();
          renderTable();
     }

     // ── Wait Waterfall Bar Chart ──────────────────────────
     function renderWaterfall() {
          const container = document.getElementById('waterfall-chart');
          container.innerHTML = '';

          const stats = buildLockStats(filteredData).slice(0, 10);
          if (!stats.length) { container.innerHTML = '<div style="color:var(--text-muted);padding:12px">No lock data.</div>'; return; }

          const W = Math.max(320, container.clientWidth || 400);
          const H = Math.max(260, container.clientHeight || 0);
          const M = { top: 6, right: 20, bottom: 55, left: 145 };
          const iW = Math.max(1, W - M.left - M.right), iH = Math.max(1, H - M.top - M.bottom);

          const yScl = d3.scaleBand().domain(stats.map(d => d.resource)).range([0, iH]).padding(0.2);
          const xScl = d3.scaleLinear().domain([0, stats[0].wait]).range([0, iW]).nice();

          const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
          const gradEl = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
          gradEl.id = 'wfall-grad'; gradEl.setAttribute('x1', '0%'); gradEl.setAttribute('x2', '100%');
          const s1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop'); s1.setAttribute('offset', '0%'); s1.setAttribute('stop-color', '#e53935');
          const s2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop'); s2.setAttribute('offset', '100%'); s2.setAttribute('stop-color', '#ab47bc');
          gradEl.appendChild(s1); gradEl.appendChild(s2); defs.appendChild(gradEl);

          const svg = d3.select(container).append('svg')
               .attr('width', W).attr('height', H)
               .attr('viewBox', `0 0 ${W} ${H}`)
               .style('width', '100%')
               .style('height', '100%');
          svg.node().appendChild(defs);
          const g = svg.append('g').attr('transform', `translate(${M.left},${M.top})`);

          g.selectAll('.wf-bar')
               .data(stats)
               .join('rect')
               .attr('class', 'wf-bar')
               .attr('y', d => yScl(d.resource))
               .attr('height', yScl.bandwidth())
               .attr('rx', 3).attr('fill', 'url(#wfall-grad)')
               .attr('x', 0).attr('width', 0)
               .transition().duration(500).delay((_, i) => i * 35)
               .attr('width', d => Math.max(2, xScl(d.wait)));

          g.selectAll('.wf-lbl')
               .data(stats)
               .join('text')
               .attr('x', d => xScl(d.wait) + 5)
               .attr('y', d => yScl(d.resource) + yScl.bandwidth() / 2)
               .attr('dy', '0.35em')
               .attr('fill', 'var(--text-secondary)').attr('font-size', '11px')
               .attr('font-family', "'JetBrains Mono',monospace")
               .text(d => formatUs(d.wait));

          g.append('g').attr('class', 'axis').call(d3.axisLeft(yScl).tickFormat(d => d.length > 16 ? d.slice(0, 14) + '…' : d));
          g.append('g').attr('class', 'axis').attr('transform', `translate(0,${iH})`)
               .call(d3.axisBottom(xScl).ticks(4).tickFormat(formatUs))
               .selectAll('text').attr('transform', 'rotate(-15)').attr('text-anchor', 'end');
     }

     // ── Lock Ranking Table ────────────────────────────────
     function renderTable() {
          const container = document.getElementById('lock-table-container');
          container.innerHTML = '';

          const stats = buildLockStats(filteredData);
          const maxWait = stats[0]?.wait || 1;

          const wrap = document.createElement('div');
          wrap.className = 'lock-table-wrap';
          const table = document.createElement('table');
          table.className = 'lock-table';
          table.innerHTML = `
            <thead>
                <tr>
                    <th>Resource</th>
                    <th>Total Wait</th>
                    <th>Lock Ops</th>
                    <th>Threads</th>
                    <th>Deadlocks</th>
                </tr>
            </thead>
        `;
          const tbody = document.createElement('tbody');
          stats.forEach(s => {
               const row = document.createElement('tr');
               const pct = (s.wait / maxWait * 100).toFixed(0);
               row.innerHTML = `
                <td class="lock-resource-cell" title="${s.resource}"><span class="lock-resource-name">${s.resource}</span></td>
                <td style="color:${s.wait > maxWait * 0.7 ? 'var(--red)' : 'var(--amber)'}">
                    ${formatUs(s.wait)}
                    <div class="wait-bar" style="width:${pct}%"></div>
                </td>
                <td>${s.acquires}</td>
                <td>${s.threads}</td>
                <td style="color:${s.deadlocks > 0 ? 'var(--purple)' : 'var(--text-muted)'}">${s.deadlocks || '—'}</td>
            `;
               tbody.appendChild(row);
          });
          table.appendChild(tbody);
          wrap.appendChild(table);
          container.appendChild(wrap);
     }

     function bindBus() {
          EventBus.on('scenarioFilter', ({ scenario }) => {
               filteredData = scenario === 'all' ? allData : allData.filter(d => d.scenario === scenario);
               if (document.getElementById('page-contention').classList.contains('active')) renderAll();
          });
     }

     function triggerResize() {
          if (!allData.length) return;
          renderAll();
     }

     return { init, triggerResize };
})();
