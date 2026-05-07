/**
 * main.js v2 — Multi-page Orchestrator
 * Handles: data loading, page routing, scenario filters, chart init per-page
 */

(async function () {
     const loading = document.getElementById('loading-screen');
     const loadSub = document.getElementById('loading-sub');
     const FALLBACK_ADDR_MIN = 0xAA001000;
     const FALLBACK_ADDR_MAX = 0xCC003080;

     // ── Page routing ─────────────────────────────────────
     const PAGE_META = {
          overview:   { title: 'Overview',         sub: 'System summary, key metrics, and the dominant performance signals', tab1: 'Overview',          tab2: 'Summary view',       tab3: 'Trace loaded' },
          timeline:   { title: 'Thread Timeline',  sub: 'Zoom, pan, and isolate thread activity across the execution window', tab1: 'Threads',           tab2: 'Execution lanes',    tab3: 'Interactive' },
          memory:     { title: 'Memory Analysis',  sub: 'Cache-line contention heatmap and hottest address ranges', tab1: 'Memory',            tab2: 'Hotspot view',       tab3: 'Contention aware' },
          contention: { title: 'Lock Contention',  sub: 'Mutex pressure, blockers, and inter-thread wait topology', tab1: 'Locks',             tab2: 'Wait topology',      tab3: 'Critical blockers' },
          profiler:   { title: 'Thread Profiler',  sub: 'Per-thread compute versus wait signatures and distribution breakdown', tab1: 'Profiler',          tab2: 'Per-thread focus',   tab3: 'Distribution' },
          dependency: { title: 'Dependency Graph', sub: 'Interactive topology of thread influence through time', tab1: 'Dependencies',      tab2: 'Causal graph',       tab3: 'Time scrubber' },
          timeline3d: { title: 'Spatial Timeline', sub: 'Spatial duration map with orbit, zoom, and event filtering controls', tab1: '3D timeline',       tab2: 'Spatial reading',    tab3: 'Immersive' },
          galaxy3d:   { title: 'Thread Galaxy',    sub: 'Thread clusters rendered as a live topological field', tab1: '3D galaxy',         tab2: 'Cluster field',      tab3: 'Immersive' },
          flow3d:     { title: 'Flow Field',       sub: 'Streaming particle model of event progression from older to newer states', tab1: '3D flow',           tab2: 'Temporal motion',    tab3: 'Immersive' },
     };

     // Track which pages have had their charts initialized
     const initialized = {};

     // Track which 3D page is currently running
     let active3dPage = null;
     let currentPageId = 'overview';

     function resizeActivePageCharts() {
          switch (currentPageId) {
               case 'overview':
                    OverviewCharts.triggerResize?.();
                    break;
               case 'timeline':
                    GanttChart.triggerResize?.();
                    break;
               case 'memory':
                    HeatmapChart.triggerResize?.();
                    break;
               case 'contention':
                    ChordChart.triggerResize?.();
                    LockStats.triggerResize?.();
                    break;
               case 'profiler':
                    ProfilerCharts.triggerResize?.();
                    break;
               case 'dependency':
                    DependencyGraph.triggerResize?.();
                    break;
               case 'timeline3d':
                    Timeline3D.resize();
                    break;
               case 'galaxy3d':
                    GalaxyViz.resize();
                    break;
               case 'flow3d':
                    FlowViz.resize();
                    break;
          }
     }

     let resizeTimer = null;
     function scheduleAdaptiveResize() {
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
               resizeActivePageCharts();
               resizeTimer = null;
          }, 120);
     }

     function navigateTo(pageId) {
          currentPageId = pageId;
          document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
          document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

          const page = document.getElementById('page-' + pageId);
          const navItem = document.querySelector(`.nav-item[data-page="${pageId}"]`);
          if (page) page.classList.add('active');
          if (navItem) navItem.classList.add('active');

          const meta = PAGE_META[pageId] || {};
          document.getElementById('page-title').textContent = meta.title || pageId.toUpperCase();
          document.getElementById('page-subtitle').textContent = meta.sub || '';

          // Stop any running 3D animation when leaving to another page
          if (active3dPage && active3dPage !== pageId) {
               if (active3dPage === 'galaxy3d')   GalaxyViz.stop();
               if (active3dPage === 'flow3d')     FlowViz.stop();
               if (active3dPage === 'timeline3d') Timeline3D.stop();
               active3dPage = null;
          }

          // Lazy-init 2D charts only on first visit
          if (!initialized[pageId]) {
               initialized[pageId] = true;
               if (pageId === 'memory') HeatmapChart.triggerResize?.();
               if (pageId === 'contention') { ChordChart.triggerResize?.(); LockStats.triggerResize?.(); }
               if (pageId === 'dependency') DependencyGraph.triggerResize?.();
          }

          // 3D views: always (re)start when navigated to — defer 2 frames
          // so the page div is fully visible and has proper layout dimensions
          if (pageId === 'timeline3d') {
               active3dPage = 'timeline3d';
               requestAnimationFrame(() => requestAnimationFrame(() => Timeline3D.start()));
          }
          if (pageId === 'galaxy3d') {
               active3dPage = 'galaxy3d';
               requestAnimationFrame(() => requestAnimationFrame(() => GalaxyViz.start()));
          }
          if (pageId === 'flow3d') {
               active3dPage = 'flow3d';
               requestAnimationFrame(() => requestAnimationFrame(() => FlowViz.start()));
          }
     }

     // ── Wire nav items ────────────────────────────────────
     document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
          btn.addEventListener('click', () => navigateTo(btn.dataset.page));
     });

     // ── Sidebar toggle ────────────────────────────────────
     const appShell = document.getElementById('app-shell');
     const sidebarToggle = document.getElementById('sidebar-toggle');
     // Restore state
     const savedSidebarState = localStorage.getItem('cm_sidebar_collapsed');
     if (savedSidebarState === '1' || (savedSidebarState === null && window.innerWidth <= 960)) {
          appShell.classList.add('sidebar-collapsed');
     }
     sidebarToggle?.addEventListener('click', () => {
          appShell.classList.toggle('sidebar-collapsed');
          localStorage.setItem('cm_sidebar_collapsed',
               appShell.classList.contains('sidebar-collapsed') ? '1' : '0');
          scheduleAdaptiveResize();
     });

     // ── Data load ─────────────────────────────────────────
     function hashString(input) {
          let hash = 2166136261;
          for (let i = 0; i < input.length; i++) {
               hash ^= input.charCodeAt(i);
               hash = Math.imul(hash, 16777619);
          }
          return hash >>> 0;
     }

     function deriveFallbackAddr(event) {
          if (typeof event.addr === 'string' && /^0x[0-9a-f]+$/i.test(event.addr)) {
               return event.addr;
          }

          const contentionEvents = new Set(['LOCK_WAIT', 'LOCK_ACQUIRE', 'LOCK_RELEASE', 'DEADLOCK_DETECTED']);
          if (!contentionEvents.has(event.event) && !event.resource) {
               return '';
          }

          const span = Math.max(1, FALLBACK_ADDR_MAX - FALLBACK_ADDR_MIN);
          const offset = hashString(`${event.resource}|${event.event}|${event.tid}`) % span;
          return '0x' + (FALLBACK_ADDR_MIN + offset).toString(16).toUpperCase();
     }

     function normalizeTrace(raw) {
          if (!Array.isArray(raw)) {
               throw new Error('Trace file must be a JSON array of events.');
          }

          return raw.map((d, index) => {
               const ts = Number(d?.ts);
               const tid = Number(d?.tid);
               const duration = Math.max(0, Number(d?.duration_us) || 0);
               const event = typeof d?.event === 'string' ? d.event.trim() : '';

               if (!Number.isFinite(ts) || !Number.isFinite(tid) || !event) {
                    return null;
               }

               const normalized = {
                    ts,
                    tid,
                    event,
                    resource: typeof d?.resource === 'string' ? d.resource : '',
                    addr: typeof d?.addr === 'string' ? d.addr : '',
                    duration_us: duration,
                    scenario: typeof d?.scenario === 'string' && d.scenario.trim() ? d.scenario : 'uncategorized',
                    __index: index
               };

               normalized.addr = deriveFallbackAddr(normalized);
               return normalized;
          }).filter(Boolean).sort((a, b) => (a.ts - b.ts) || (a.tid - b.tid) || (a.__index - b.__index));
     }

     async function processTraceData(raw) {
          // Hide welcome, show loading
          document.getElementById('welcome-screen').classList.add('hidden');
          loading.classList.remove('hidden');

          const data = normalizeTrace(raw);
          if (!data.length) {
               throw new Error('Trace does not contain any valid events.');
          }

          loadSub.textContent = 'PARSING ' + data.length.toLocaleString() + ' EVENTS…';
          await new Promise(r => setTimeout(r, 50));

          loadSub.textContent = 'INITIALISING VIEWS…';
          await new Promise(r => setTimeout(r, 50));

          const tooltip = document.getElementById('global-tooltip');

          // ── Status bar ────────────────────────────────────
          const threads = [...new Set(data.map(d => d.tid))];
          const te = d3.extent(data, d => d.ts);
          const dlCount = data.filter(d => d.event === 'DEADLOCK_DETECTED').length;

          document.getElementById('gs-events').textContent = data.length.toLocaleString();
          document.getElementById('gs-threads').textContent = threads.length;
          document.getElementById('gs-dur').textContent = fUs(te[1] - te[0]);
          document.getElementById('deadlock-badge').style.display = (dlCount > 0) ? 'inline-flex' : 'none';
          const brandSub = document.getElementById('brand-sub');
          if (brandSub) brandSub.textContent = `ACTIVE_THREADS: ${threads.length}`;

          EventBus.clear();

          // ── Init all 2D charts (each isolated so one crash can't block others) ──
          const tryInit = (name, fn) => { try { fn(); } catch(e) { console.warn(`[CM] ${name} init failed:`, e.message); } };

          tryInit('Overview',    () => OverviewCharts.init(data));
          tryInit('Gantt',       () => GanttChart.init(data, tooltip));
          tryInit('Heatmap',     () => HeatmapChart.init(data, tooltip));
          tryInit('Chord',       () => ChordChart.init(data, tooltip));
          tryInit('Stats',       () => StatsPanel.init(data));
          tryInit('Profiler',    () => ProfilerCharts.init(data));
          tryInit('LockStats',   () => LockStats.init(data));
          tryInit('Dependency',  () => DependencyGraph.init(data, tooltip));

          // ── Init 3D visualization modules (data only, no render yet) ──
          tryInit('Timeline3D',  () => Timeline3D.init(data));
          tryInit('Galaxy3D',    () => GalaxyViz.init(data));
          tryInit('Flow3D',      () => FlowViz.init(data));

          // ── Populate Timeline3D HUD ──────────────────────────
          const tl3Threads = [...new Set(data.map(d => d.tid))].length;
          const tl3Events  = data.filter(d => d.duration_us > 0 && !['THREAD_START','THREAD_END'].includes(d.event)).length;
          const tl3Span    = d3.extent(data, d => d.ts);
          const el = (id) => document.getElementById(id);
          if (el('tl3-hud-threads')) el('tl3-hud-threads').textContent = tl3Threads;
          if (el('tl3-hud-events'))  el('tl3-hud-events').textContent  = tl3Events.toLocaleString();
          if (el('tl3-hud-dur'))     el('tl3-hud-dur').textContent     = fUs(tl3Span[1] - tl3Span[0]);

          // ── Build Timeline3D colour legend ────────────────────
          const tl3Legend = document.getElementById('tl3-legend');
          if (tl3Legend) {
               const evTypes = [...new Set(data.filter(d => d.duration_us > 0).map(d => d.event))].sort();
               tl3Legend.innerHTML = evTypes.map(ev => {
                    const col = EventBus.colors[ev] || '#64748b';
                    return `<div class="viz3d-legend-item"><span class="viz3d-dot" style="background:${col}"></span>${ev.replace('_',' ').toLowerCase()}</div>`;
               }).join('');
          }

          // ── Stop any running 3D animations before navigating away ──
          Timeline3D.stop();
          GalaxyViz.stop();
          FlowViz.stop();

          // Reset 3D initialization state so they re-start cleanly on next visit
          delete initialized['timeline3d'];
          delete initialized['galaxy3d'];
          delete initialized['flow3d'];
          active3dPage = null;

          // ── Hide loading ──────────────────────────────────
          loading.classList.add('hidden');
          navigateTo('overview');
     }

     // ── Expose loader so welcome screen button can call it ────
     window.__cmLoad = processTraceData;

     // ── Initial state: show welcome screen, no data auto-load ─
     // (loading screen starts hidden; welcome screen is shown in HTML)

     // ── Shared file reader ────────────────────────────────
     function loadFile(file) {
          if (!file) return;
          loadSub.textContent = 'READING FILE…';
          loadSub.style.color = '#c9d1d9';
          const reader = new FileReader();
          reader.onload = async (ev) => {
               try {
                    const raw = JSON.parse(ev.target.result);
                    await processTraceData(raw);
               } catch (err) {
                    loading.classList.add('hidden');
                    document.getElementById('welcome-screen').classList.remove('hidden');
                    loadSub.textContent = 'FAILED TO LOAD TRACE';
                    loadSub.style.color = '#ef4444';
                    console.error('JSON parse error:', err);
               }
          };
          reader.readAsText(file);
     }

     // ── Welcome screen upload ──────────────────────────────
     document.getElementById('trace-upload').addEventListener('change', (e) => {
          loadFile(e.target.files[0]);
          e.target.value = '';
     });

     // ── Sample data button ────────────────────────────────
     document.getElementById('wc-load-sample')?.addEventListener('click', () => {
          if (window.SAMPLE_TRACE && window.SAMPLE_TRACE.length > 0) {
               processTraceData(window.SAMPLE_TRACE);
          }
     });

     document.getElementById('wc-load-large-sample')?.addEventListener('click', () => {
          if (window.MANY_THREAD_TRACE && window.MANY_THREAD_TRACE.length > 0) {
               processTraceData(window.MANY_THREAD_TRACE);
          }
     });

     // ── Drag-and-drop on welcome screen ───────────────────
     const dropzone = document.getElementById('wc-dropzone');
     ['dragenter', 'dragover'].forEach(ev => dropzone.addEventListener(ev, e => {
          e.preventDefault();
          dropzone.classList.add('drag-over');
     }));
     ['dragleave', 'drop'].forEach(ev => dropzone.addEventListener(ev, e => {
          e.preventDefault();
          dropzone.classList.remove('drag-over');
          if (ev === 'drop' && e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
     }));

     // ── Topbar upload (reloads new trace) ─────────────────
     document.getElementById('trace-upload-topbar').addEventListener('change', (e) => {
          loadFile(e.target.files[0]);
          e.target.value = '';
     });

     // ── UI Events ─────────────────────────────────────────
     document.getElementById('btn-reset').addEventListener('click', () => {
          EventBus.emit('timeRange', null);
          EventBus.emit('threadSelect', { tid: null });
          EventBus.emit('scenarioFilter', { scenario: 'all' });
     });

     document.getElementById('btn-reset-sidebar')?.addEventListener('click', () => {
          EventBus.emit('timeRange', null);
          EventBus.emit('threadSelect', { tid: null });
          EventBus.emit('scenarioFilter', { scenario: 'all' });
     });

     // ── Adaptive resize handling for all views ────────────
     window.addEventListener('resize', scheduleAdaptiveResize);
     if (typeof ResizeObserver !== 'undefined') {
          const resizeObserver = new ResizeObserver(() => scheduleAdaptiveResize());
          resizeObserver.observe(appShell);
          resizeObserver.observe(document.getElementById('app-main'));
     }

     function fUs(v) {
          if (v >= 1e6) return (v / 1e6).toFixed(2) + 's';
          if (v >= 1e3) return (v / 1e3).toFixed(1) + 'ms';
          return v.toFixed(0) + 'µs';
     }
})();
