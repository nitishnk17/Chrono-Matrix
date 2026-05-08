/**
 * dependency.js — Force-directed Thread Dependency Graph

 */
const DependencyGraph = (() => {

     let allData = [];
     let filteredData = [];
     let tooltip;

     // D3 state
     let svg, containerGroup, linkGroup, nodeGroup, labelGroup;
     let simulation;
     let width, height;

     // Processed data
     let dependencyIntervals = []; // Array of { start, end, waiterTid, ownerTid, resource }
     let activeNodes = [];
     let activeLinks = [];

     // State
     let currentTimeRange = null; // {t0, t1}
     let currentScenario = 'all';

     function init(data, tooltipEl) {
          allData = data;
          filteredData = data;
          tooltip = tooltipEl;

          const container = document.getElementById('dependency-chart');
          width = container.clientWidth || 800;
          height = container.clientHeight || 500;

          container.innerHTML = '';

          // Setup SVG
          svg = d3.select(container).append('svg')
               .attr('width', width)
               .attr('height', height);

          // Setup defs for arrowheads
          const defs = svg.append('defs');
          defs.append('marker')
               .attr('id', 'arrowhead')
               .attr('viewBox', '0 -5 10 10')
               .attr('refX', 30) // Push it further out from the center to clear the radius=16 node
               .attr('refY', 0)
               .attr('orient', 'auto')
               .attr('markerWidth', 5)
               .attr('markerHeight', 5)
               .style('overflow', 'visible')
               .append('svg:path')
               .attr('d', 'M 0,-5 L 10 ,0 L 0,5')
               .attr('fill', EventBus.colors.LOCK_WAIT)
               .style('stroke', 'none');

          // Allow zoom/pan
          const zoom = d3.zoom()
               .scaleExtent([0.1, 4])
               .on('zoom', (event) => {
                    containerGroup.attr('transform', event.transform);
               });
          svg.call(zoom);

          containerGroup = svg.append('g');
          linkGroup = containerGroup.append('g').attr('class', 'links');
          nodeGroup = containerGroup.append('g').attr('class', 'nodes');
          labelGroup = containerGroup.append('g').attr('class', 'labels');

          // Setup Simulation
          simulation = d3.forceSimulation()
               .force('link', d3.forceLink().id(d => d.id).distance(220)) // Increased distance
               .force('charge', d3.forceManyBody().strength(-1500)) // Much stronger repulsion
               .force('center', d3.forceCenter(width / 2, height / 2))
               .force('collision', d3.forceCollide().radius(50)); // Prevent overlapping

          // Setup Time Scrubber
          const scrubber = document.getElementById('dep-time-scrubber');
          const timeDisplay = document.getElementById('dep-time-display');

          scrubber.addEventListener('input', (e) => {
               const pct = parseInt(e.target.value, 10) / 1000;
               timeDisplay.textContent = (pct * 100).toFixed(1) + '%';

               if (!allData || !allData.length) return;
               const te = d3.extent(allData, d => d.ts);
               const t1 = te[0] + pct * (te[1] - te[0]);

               // Use a trailing 15% moving window for the scrubber so threads can "finish"
               const windowSize = (te[1] - te[0]) * 0.15;
               const t0 = Math.max(te[0], t1 - windowSize);

               // Debounce the global event emit slightly so we don't spam 60fps
               if (window._scrubTimeout) clearTimeout(window._scrubTimeout);
               window._scrubTimeout = setTimeout(() => {
                    window._ignoreNextTimeRange = true;
                    EventBus.emit('timeRange', { t0, t1 });
                    setTimeout(() => { window._ignoreNextTimeRange = false; }, 100);
               }, 50);

               // But update graph immediately locally
               currentTimeRange = { t0, t1 };
               calculateActiveGraph();
          });

          processDependencies();

          if (allData && allData.length) {
               const te = d3.extent(allData, d => d.ts);
               const windowSize = (te[1] - te[0]) * 0.15;
               currentTimeRange = { t0: Math.max(te[0], te[1] - windowSize), t1: te[1] };
          }

          updateFilter(currentScenario);
          bindBus();
     }

     function processDependencies() {
          // We need to figure out who owns which lock at what time.
          // Lock state: resourceName -> { ownerTid, acquireTs, releaseTs }

          // Sort data chronologically just in case
          let sorted = [...allData].sort((a, b) => a.ts - b.ts);

          let lockState = {};
          dependencyIntervals = [];

          // First pass: Track successful acquisitions and releases to find ownership intervals
          let ownerships = [];
          for (let d of sorted) {
               // Only successful acquisitions start an ownership interval.
               if (d.event === 'LOCK_ACQUIRE' || d.event === 'LOCK_WAIT') {
                    // The hold starts exactly when the wait/acquire finishes
                    lockState[d.resource] = { ownerTid: d.tid, startT: d.ts };
               } else if (d.event === 'LOCK_RELEASE') {
                    if (lockState[d.resource] && lockState[d.resource].ownerTid === d.tid) {
                         let startT = lockState[d.resource].startT;
                         ownerships.push({
                              resource: d.resource,
                              ownerTid: d.tid,
                              startT: startT,
                              endT: d.ts
                         });
                         delete lockState[d.resource]; // Released
                    }
               }
          }

          // If there are locks acquired and never released at the end of the trace:
          for (let res in lockState) {
               ownerships.push({
                    resource: res,
                    ownerTid: lockState[res].ownerTid,
                    startT: lockState[res].startT,
                    endT: sorted[sorted.length - 1].ts // extend to end of trace
               });
          }

          // Second pass: Find waiters and map them to the owner at that time
          for (let d of sorted) {
               if (d.event === 'LOCK_WAIT' || d.event === 'LOCK_WAIT_TIMEOUT' || d.event === 'COND_WAIT') {
                    let waitStart = d.ts - d.duration_us;
                    let waitEnd = d.ts;

                    // Which ownership interval overlapped this wait?
                    let ownerOps = ownerships.filter(o =>
                         o.resource === d.resource &&
                         o.ownerTid !== d.tid && // can't wait on yourself
                         (
                              (waitStart >= o.startT && waitStart <= o.endT) || // starts during
                              (waitEnd >= o.startT && waitEnd <= o.endT) ||     // ends during
                              (waitStart <= o.startT && waitEnd >= o.endT)      // encompasses
                         )
                    );

                    // If multiple owners held the lock during our wait (e.g. wait was long and lock bounced),
                    // we create a dependency edge to the LAST one before we acquired it, or all of them.
                    // For a Wait-For graph, typically we draw an edge to the most prominent/recent blocker.
                    let ownerOp = ownerOps[ownerOps.length - 1];

                    if (ownerOp) {
                         // Record a dependency: Waiter -> Owner
                         dependencyIntervals.push({
                              waiterTid: d.tid,
                              ownerTid: ownerOp.ownerTid,
                              resource: d.resource,
                              startT: waitStart,
                              endT: waitEnd,
                              duration_us: d.duration_us,
                              scenario: d.scenario
                         });
                    }
               }
          }

          console.log("Processed", dependencyIntervals.length, "dependency intervals");
     }

     function calculateActiveGraph() {
          // Filter dependency intervals based on scenario and timeRange

          let validIntervals = dependencyIntervals;

          if (currentScenario !== 'all') {
               validIntervals = validIntervals.filter(i => i.scenario === currentScenario);
          }

          if (currentTimeRange) {
               let t0 = currentTimeRange.t0;
               let t1 = currentTimeRange.t1;

               // Interval must overlap with selected time window
               validIntervals = validIntervals.filter(i =>
               ((i.startT >= t0 && i.startT <= t1) ||
                    (i.endT >= t0 && i.endT <= t1) ||
                    (i.startT <= t0 && i.endT >= t1))
               );
          }

          // Group by waiter -> owner pair
          let edgeMap = {};
          let nodeSet = new Set();

          for (let i of validIntervals) {
               let key = `${i.waiterTid}-${i.ownerTid}`;
               if (!edgeMap[key]) {
                    edgeMap[key] = {
                         source: i.waiterTid,
                         target: i.ownerTid,
                         waitCount: 0,
                         totalDuration: 0,
                         resources: new Set()
                    };
               }
               edgeMap[key].waitCount++;
               edgeMap[key].totalDuration += i.duration_us;
               edgeMap[key].resources.add(i.resource);

               nodeSet.add(i.waiterTid);
               nodeSet.add(i.ownerTid);
          }

          // Also add threads that are doing things in this time range but not waiting
          let relevantData = filteredData;
          if (currentTimeRange) {
               let t0 = currentTimeRange.t0;
               let t1 = currentTimeRange.t1;
               relevantData = filteredData.filter(d => {
                    const s = d.ts - d.duration_us;
                    return ((s >= t0 && s <= t1) || (d.ts >= t0 && d.ts <= t1) || (s <= t0 && d.ts >= t1));
               });
          }

          for (let d of relevantData) {
               nodeSet.add(d.tid);
          }

          // Sort nodes by how much they are interacting (waiting or being waited on)
          let nodeWeights = {};
          nodeSet.forEach(n => nodeWeights[n] = 0);

          Object.values(edgeMap).forEach(e => {
               nodeWeights[e.source] += e.totalDuration;
               nodeWeights[e.target] += e.totalDuration;
          });

          let sortedNodes = Array.from(nodeSet).sort((a, b) => nodeWeights[b] - nodeWeights[a]);

          const MAX_NODES = 80;
          let keepNodes = new Set(sortedNodes.slice(0, MAX_NODES));
          let culledNodeIds = new Set(sortedNodes.slice(MAX_NODES));

          // Convert to D3 format
          activeNodes = Array.from(keepNodes).map(id => ({ id: id, isAggregate: false }));

          if (culledNodeIds.size > 0) {
               activeNodes.push({ id: 'Other', isAggregate: true });
          }

          activeLinks = Object.values(edgeMap).map(e => {
               let src = keepNodes.has(e.source) ? e.source : 'Other';
               let tgt = keepNodes.has(e.target) ? e.target : 'Other';

               return {
                    ...e,
                    originalSource: e.source,
                    originalTarget: e.target,
                    source: src,
                    target: tgt,
                    resourcesArr: Array.from(e.resources).join(', ')
               };
          });

          // Collapse duplicate Other -> Other links
          let finalLinksMap = {};
          activeLinks.forEach(l => {
               let k = `${l.source}-${l.target}`;
               // Don't draw self-referential 'Other' loops to avoid physics jitter
               if (l.source === 'Other' && l.target === 'Other') return;

               if (!finalLinksMap[k]) {
                    finalLinksMap[k] = { ...l };
               } else {
                    finalLinksMap[k].waitCount += l.waitCount;
                    finalLinksMap[k].totalDuration += l.totalDuration;
               }
          });

          activeLinks = Object.values(finalLinksMap);

          renderGraph();
     }

     function renderGraph() {
          // Update Nodes
          let node = nodeGroup.selectAll('.node')
               .data(activeNodes, d => d.id);

          node.exit().remove();

          let nodeEnter = node.enter()
               .append('circle')
               .attr('class', 'node')
               .attr('r', d => d.isAggregate ? 22 : 16)
               .attr('fill', '#111827')
               .attr('stroke', d => d.isAggregate ? '#94a3b8' : EventBus.colors.COMPUTE)
               .attr('stroke-width', 2)
               .attr('stroke-dasharray', d => d.isAggregate ? '4,4' : 'none')
               .call(d3.drag()
                    .on('start', dragstarted)
                    .on('drag', dragged)
                    .on('end', dragended))
               .on('mouseover', showNodeTooltip)
               .on('mouseout', hideTooltip)
               .on('click', (event, d) => { if (!d.isAggregate) EventBus.emit('threadSelect', { tid: d.id }) });

          node = nodeEnter.merge(node);

          // Update Labels
          let label = labelGroup.selectAll('.label')
               .data(activeNodes, d => d.id);

          label.exit().remove();

          let labelEnter = label.enter()
               .append('text')
               .attr('class', 'label')
               .attr('text-anchor', 'middle')
               .attr('dy', 4)
               .attr('fill', '#f8fafc')
               .attr('stroke', '#020617')
               .attr('stroke-width', 3)
               .attr('paint-order', 'stroke')
               .attr('font-size', '10px')
               .style('pointer-events', 'none')
               .text(d => `T-${d.id}`);

          label = labelEnter.merge(label);

          // Update Links
          let link = linkGroup.selectAll('.link')
               .data(activeLinks, d => `${d.source.id || d.source}-${d.target.id || d.target}`);

          link.exit().remove();

          let linkEnter = link.enter()
               .append('path')
               .attr('class', 'link')
               .attr('fill', 'none')
               .attr('stroke', EventBus.colors.LOCK_WAIT)
               .attr('stroke-width', d => Math.max(2.0, Math.min(8, Math.sqrt(d.waitCount) + 1)))
               .attr('opacity', 0.8)
               .attr('marker-end', 'url(#arrowhead)')
               .style('cursor', 'pointer')
               .on('mouseover', showLinkTooltip)
               .on('mouseout', hideTooltip);

          link = linkEnter.merge(link);

          // Restart simulation
          simulation.nodes(activeNodes);
          simulation.force('link').links(activeLinks);
          simulation.alpha(1).restart();

          simulation.on('tick', () => {
               link.attr('d', d => {
                    // Curved lines for two-way dependencies to prevent overlap
                    let dx = d.target.x - d.source.x,
                         dy = d.target.y - d.source.y,
                         dr = Math.sqrt(dx * dx + dy * dy);

                    // Check if reverse link exists
                    let isTwoWay = activeLinks.some(l => l.source === d.target && l.target === d.source);

                    if (isTwoWay) {
                         let stretch = dr * 1.5;
                         return `M${d.source.x},${d.source.y}A${stretch},${stretch} 0 0,1 ${d.target.x},${d.target.y}`;
                    } else {
                         return `M${d.source.x},${d.source.y}L${d.target.x},${d.target.y}`;
                    }
               });

               node
                    .attr('cx', d => d.x)
                    .attr('cy', d => d.y);

               label
                    .attr('x', d => d.x)
                    .attr('y', d => d.y);
          });

          updateMeta();
     }

     function formatUs(v) {
          if (v >= 1e6) return (v / 1e6).toFixed(2) + 's';
          if (v >= 1e3) return (v / 1e3).toFixed(1) + 'ms';
          return v.toFixed(0) + 'µs';
     }

     function showNodeTooltip(event, d) {
          tooltip.classList.add('visible');
          tooltip.innerHTML = `
            <div class="tt-title">Thread T-${d.id}</div>
            <div class="tt-row"><span class="tt-key">Waiting on</span><span class="tt-val">${activeLinks.filter(l => l.source.id === d.id).length} threads</span></div>
            <div class="tt-row"><span class="tt-key">Blocking</span><span class="tt-val">${activeLinks.filter(l => l.target.id === d.id).length} threads</span></div>
        `;
          EventBus.positionTooltip(tooltip, event);
     }

     function showLinkTooltip(event, d) {
          tooltip.classList.add('visible');
          tooltip.innerHTML = `
            <div class="tt-title">Dependency</div>
            <div style="color:#ffb74d; margin-bottom:8px;">T-${d.source.id} ➔ T-${d.target.id}</div>
            <div class="tt-row"><span class="tt-key">Reason</span><span class="tt-val" style="color:var(--amber)">Waiting on Resource</span></div>
            <div class="tt-row"><span class="tt-key">Resources</span><span class="tt-val">${d.resourcesArr.substring(0, 30)}${d.resourcesArr.length > 30 ? '...' : ''}</span></div>
            <div class="tt-row"><span class="tt-key">Wait Events</span><span class="tt-val">${d.waitCount}</span></div>
            <div class="tt-row"><span class="tt-key">Total Wait Time</span><span class="tt-val">${formatUs(d.totalDuration)}</span></div>
        `;
          EventBus.positionTooltip(tooltip, event);
     }

     function hideTooltip() {
          tooltip.classList.remove('visible');
     }

     function dragstarted(event, d) {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
     }

     function dragged(event, d) {
          d.fx = event.x;
          d.fy = event.y;
     }

     function dragended(event, d) {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null;
          d.fy = null;
     }

     function updateMeta() {
          document.getElementById('dependency-meta').textContent =
               `${activeNodes.length} active threads · ${activeLinks.length} dependencies`;
     }

     function updateFilter(scenario) {
          currentScenario = scenario;
          filteredData = scenario === 'all' ? allData : allData.filter(d => d.scenario === scenario);
          calculateActiveGraph();
     }

     function bindBus() {
          EventBus.on('scenarioFilter', ({ scenario }) => updateFilter(scenario));
          EventBus.on('timeRange', (tr) => {
               if (window._ignoreNextTimeRange) return;

               // Sync scrubber if event came from elsewhere (like Gantt chart brush)
               const scrubber = document.getElementById('dep-time-scrubber');
               const timeDisplay = document.getElementById('dep-time-display');
               if (allData.length && tr) {
                    const te = d3.extent(allData, d => d.ts);
                    const pct = Math.max(0, Math.min(1, Math.abs(tr.t1 - te[0]) / (te[1] - te[0])));
                    scrubber.value = Math.round(pct * 1000);
                    timeDisplay.textContent = (pct * 100).toFixed(1) + '%';
                    currentTimeRange = tr;
               } else if (!tr && allData.length) {
                    scrubber.value = 1000;
                    timeDisplay.textContent = '100.0%';
                    const te = d3.extent(allData, d => d.ts);
                    const windowSize = (te[1] - te[0]) * 0.15;
                    currentTimeRange = { t0: Math.max(te[0], te[1] - windowSize), t1: te[1] };
               }

               calculateActiveGraph();
          });

          // Highlight nodes if selected elsewhere
          EventBus.on('threadSelect', ({ tid }) => {
               nodeGroup.selectAll('.node')
                    .attr('stroke', d => d.id === tid ? EventBus.colors.LOCK_ACQUIRE : EventBus.colors.COMPUTE)
                    .attr('stroke-width', d => d.id === tid ? 4 : 2);
          });
     }

     function triggerResize() {
          const container = document.getElementById('dependency-chart');
          width = container.clientWidth || 800;
          height = container.clientHeight || 500;
          if (svg) {
               svg.attr('width', width).attr('height', height);
               simulation.force('center', d3.forceCenter(width / 2, height / 2));
               simulation.alpha(0.3).restart();
          }
     }

     return { init, triggerResize };
})();
