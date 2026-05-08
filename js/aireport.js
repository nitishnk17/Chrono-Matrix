/**
 * aireport.js — local trace report generator
 *
 * Produces a deterministic diagnostic report from the loaded trace.
 * Optional model settings can be saved for future AI-backed integrations.
 */

const AIReport = (() => {
     let allData = [];
     const STORAGE_KEY = 'cm_ai_model_settings';

     function formatUs(v) {
          if (v >= 1e6) return (v / 1e6).toFixed(2) + 's';
          if (v >= 1e3) return (v / 1e3).toFixed(1) + 'ms';
          return Math.max(0, v || 0).toFixed(0) + 'µs';
     }

     function pct(part, total) {
          return ((part / Math.max(1, total)) * 100).toFixed(1) + '%';
     }

     function eventLabel(event) {
          return String(event || 'UNKNOWN').replace(/_/g, ' ').toLowerCase();
     }

     function computeReport(data) {
          const threads = new Set();
          const scenarios = new Set();
          const byEvent = new Map();
          const byThread = new Map();
          const byResource = new Map();
          const byScenario = new Map();
          const memoryEvents = [];
          let computeTime = 0;
          let waitTime = 0;
          let sleepTime = 0;
          let ioTime = 0;
          let lockWaits = 0;
          let timeouts = 0;
          let deadlocks = 0;

          const te = d3.extent(data, d => d.ts);
          const duration = (te[1] - te[0]) || 1;

          data.forEach(d => {
               threads.add(d.tid);
               scenarios.add(d.scenario || 'uncategorized');
               byEvent.set(d.event, (byEvent.get(d.event) || 0) + 1);
               byScenario.set(d.scenario || 'uncategorized', (byScenario.get(d.scenario || 'uncategorized') || 0) + 1);

               const th = byThread.get(d.tid) || { events: 0, compute: 0, wait: 0, memory: 0, deadlocks: 0 };
               th.events++;

               if (d.event === 'COMPUTE') {
                    computeTime += d.duration_us || 0;
                    th.compute += d.duration_us || 0;
               }

               if (['LOCK_WAIT', 'LOCK_WAIT_TIMEOUT', 'COND_WAIT', 'THREAD_JOIN', 'IO_WAIT', 'SLEEP'].includes(d.event)) {
                    waitTime += d.duration_us || 0;
                    th.wait += d.duration_us || 0;
               }

               if (d.event === 'SLEEP') sleepTime += d.duration_us || 0;
               if (d.event === 'IO_WAIT') ioTime += d.duration_us || 0;
               if (d.event === 'LOCK_WAIT') lockWaits++;
               if (d.event === 'LOCK_WAIT_TIMEOUT') timeouts++;
               if (d.event === 'DEADLOCK_DETECTED') {
                    deadlocks++;
                    th.deadlocks++;
               }

               if (['MEM_READ', 'MEM_WRITE', 'MEM_ALLOC', 'MEM_FREE'].includes(d.event)) {
                    th.memory++;
                    memoryEvents.push(d);
               }

               if (d.resource) {
                    const r = byResource.get(d.resource) || { events: 0, wait: 0, deadlocks: 0, timeouts: 0 };
                    r.events++;
                    if (['LOCK_WAIT', 'LOCK_WAIT_TIMEOUT', 'COND_WAIT'].includes(d.event)) r.wait += d.duration_us || 0;
                    if (d.event === 'DEADLOCK_DETECTED') r.deadlocks++;
                    if (d.event === 'LOCK_WAIT_TIMEOUT') r.timeouts++;
                    byResource.set(d.resource, r);
               }

               byThread.set(d.tid, th);
          });

          const totalThreadTime = [...byThread.values()].reduce((sum, t) => sum + t.compute + t.wait, 0) || 1;
          const topEvents = [...byEvent.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
          const topThreads = [...byThread.entries()].sort((a, b) => b[1].wait - a[1].wait).slice(0, 6);
          const hotResources = [...byResource.entries()].sort((a, b) => b[1].wait - a[1].wait).slice(0, 6);
          const busiestScenarios = [...byScenario.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

          const issues = [];
          const recommendations = [];
          const corrections = [];

          if (deadlocks > 0) {
               issues.push({ level: 'critical', title: 'Deadlock detected', body: `${deadlocks} deadlock marker${deadlocks === 1 ? '' : 's'} appear in the trace.` });
               recommendations.push('Add lock ordering rules, avoid circular waits, and use timed lock acquisition around high-risk resources.');
               corrections.push('Inspect the Dependency page near deadlock time, identify the wait cycle, then enforce a single global lock acquisition order.');
          }

          if (waitTime / totalThreadTime > 0.25) {
               issues.push({ level: 'high', title: 'High blocking cost', body: `${pct(waitTime, totalThreadTime)} of measured thread time is waiting/blocking.` });
               recommendations.push('Reduce critical-section size, move expensive work outside locks, and consider lock-free queues or sharded locks.');
               corrections.push('Start with the top waiter threads and hottest resources listed below; optimize the largest wait bucket first.');
          }

          if (timeouts > 0) {
               issues.push({ level: 'high', title: 'Lock wait timeouts', body: `${timeouts} timeout event${timeouts === 1 ? '' : 's'} suggest starvation or unsafe contention.` });
               recommendations.push('Review timeout thresholds and confirm locks are always released on error paths.');
               corrections.push('Search for long-held resources in Contention and verify every acquire has a release in the traced workload.');
          }

          if (ioTime > computeTime * 0.35) {
               issues.push({ level: 'medium', title: 'I/O pressure', body: `I/O wait totals ${formatUs(ioTime)}, which is large relative to compute time.` });
               recommendations.push('Batch reads/writes, use async I/O, or move I/O outside synchronized regions.');
          }

          if (memoryEvents.length && memoryEvents.length / data.length > 0.30) {
               issues.push({ level: 'medium', title: 'Heavy memory activity', body: `${pct(memoryEvents.length, data.length)} of events are memory operations.` });
               recommendations.push('Check Memory and Trace Atlas for hot address bands; reduce false sharing and improve cache locality.');
          }

          if (!issues.length) {
               issues.push({ level: 'good', title: 'No severe contention pattern detected', body: 'The trace does not show deadlocks, timeouts, or unusually high blocking by the current rules.' });
               recommendations.push('Use Timeline and Profiler to validate phase balance and confirm that workload distribution is still even.');
          }

          return {
               summary: {
                    events: data.length,
                    threads: threads.size,
                    scenarios: scenarios.size,
                    duration,
                    computeTime,
                    waitTime,
                    lockWaits,
                    timeouts,
                    deadlocks,
                    memoryEvents: memoryEvents.length,
                    totalThreadTime
               },
               topEvents,
               topThreads,
               hotResources,
               busiestScenarios,
               issues,
               recommendations: [...new Set(recommendations)],
               corrections: [...new Set(corrections)]
          };
     }

     function metricCard(label, value, sub, tone = '') {
          return `<div class="ai-metric ${tone}">
               <span class="ai-metric-label">${label}</span>
               <b>${value}</b>
               <span>${sub}</span>
          </div>`;
     }

     function defaultSettings() {
          return {
               provider: 'local',
               model: '',
               endpoint: '',
               hasKey: false,
               keyPreview: ''
          };
     }

     function readSettings() {
          try {
               return { ...defaultSettings(), ...(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')) };
          } catch {
               return defaultSettings();
          }
     }

     function writeStatus(message, tone = '') {
          const status = document.getElementById('ai-key-status');
          if (!status) return;
          status.textContent = message;
          status.dataset.tone = tone;
     }

     function maskKey(key) {
          if (!key) return '';
          if (key.length <= 8) return 'saved';
          return `${key.slice(0, 4)}...${key.slice(-4)}`;
     }

     function loadSettingsIntoForm() {
          const settings = readSettings();
          const provider = document.getElementById('ai-provider');
          const model = document.getElementById('ai-model');
          const endpoint = document.getElementById('ai-endpoint');
          const key = document.getElementById('ai-api-key');
          if (provider) provider.value = settings.provider || 'local';
          if (model) model.value = settings.model || '';
          if (endpoint) endpoint.value = settings.endpoint || '';
          if (key) key.value = '';
          writeStatus(settings.hasKey ? `Saved ${settings.provider} key (${settings.keyPreview || 'masked'})` : 'Optional: local report works without a key', settings.hasKey ? 'saved' : '');
     }

     function saveSettings() {
          const provider = document.getElementById('ai-provider')?.value || 'local';
          const model = document.getElementById('ai-model')?.value.trim() || '';
          const endpoint = document.getElementById('ai-endpoint')?.value.trim() || '';
          const key = document.getElementById('ai-api-key')?.value.trim() || '';
          const previous = readSettings();

          const settings = {
               provider,
               model,
               endpoint,
               hasKey: Boolean(key || previous.hasKey),
               keyPreview: key ? maskKey(key) : previous.keyPreview,
               // This is convenient for local demos, but not suitable for production.
               apiKey: key || previous.apiKey || ''
          };

          if (provider === 'local') {
               settings.hasKey = false;
               settings.keyPreview = '';
               settings.apiKey = '';
          }

          localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
          if (document.getElementById('ai-api-key')) document.getElementById('ai-api-key').value = '';
          writeStatus(settings.hasKey ? `Saved ${provider} settings (${settings.keyPreview})` : 'Using local rule-based report', settings.hasKey ? 'saved' : '');
     }

     function clearSettings() {
          localStorage.removeItem(STORAGE_KEY);
          loadSettingsIntoForm();
          writeStatus('AI key cleared. Local report mode is active.', 'cleared');
     }

     function renderReport() {
          const content = document.getElementById('ai-report-content');
          const status = document.getElementById('ai-report-status');
          if (!content) return;

          if (!allData.length) {
               content.innerHTML = `<div class="panel ai-empty-report">
                    <div class="empty-report-title">No trace loaded</div>
                    <p>Load a sample trace or upload a JSON file first. Then this report will summarize performance risks and corrections.</p>
               </div>`;
               if (status) status.textContent = 'Waiting for trace data';
               return;
          }

          const report = computeReport(allData);
          const s = report.summary;
          const settings = readSettings();
          const modeLabel = settings.hasKey && settings.provider !== 'local'
               ? `${settings.provider} settings saved`
               : 'local analysis';
          if (status) status.textContent = `${s.events.toLocaleString()} events analyzed · ${report.issues.length} finding${report.issues.length === 1 ? '' : 's'} · ${modeLabel}`;

          content.innerHTML = `
               <div class="ai-report-grid">
                    ${metricCard('Events', s.events.toLocaleString(), `${s.threads} threads · ${s.scenarios} scenarios`)}
                    ${metricCard('Trace Window', formatUs(s.duration), 'wall-clock span')}
                    ${metricCard('Wait Share', pct(s.waitTime, s.totalThreadTime), `${formatUs(s.waitTime)} blocked`, s.waitTime / s.totalThreadTime > 0.25 ? 'warn' : 'good')}
                    ${metricCard('Deadlocks', s.deadlocks, s.deadlocks ? 'correction required' : 'none detected', s.deadlocks ? 'bad' : 'good')}
                    ${metricCard('Timeouts', s.timeouts, 'lock wait timeout events', s.timeouts ? 'warn' : 'good')}
                    ${metricCard('Memory Events', s.memoryEvents.toLocaleString(), pct(s.memoryEvents, s.events) + ' of trace')}
               </div>

               <div class="ai-report-columns">
                    <div class="panel">
                         <div class="panel-header"><div class="panel-title"><div class="icon">!</div>PROBLEM DIAGNOSIS</div></div>
                         <div class="ai-finding-list">
                              ${report.issues.map(issue => `<div class="ai-finding ${issue.level}">
                                   <b>${issue.title}</b>
                                   <p>${issue.body}</p>
                              </div>`).join('')}
                         </div>
                    </div>
                    <div class="panel">
                         <div class="panel-header"><div class="panel-title"><div class="icon">↗</div>OPTIMIZATION PLAN</div></div>
                         <ol class="ai-list">${report.recommendations.map(x => `<li>${x}</li>`).join('')}</ol>
                    </div>
               </div>

               <div class="ai-report-columns">
                    <div class="panel">
                         <div class="panel-header"><div class="panel-title"><div class="icon">T</div>TOP WAITING THREADS</div></div>
                         <div class="ai-table">${report.topThreads.map(([tid, t]) => `<div><span>T-${tid}</span><b>${formatUs(t.wait)}</b><em>${t.events.toLocaleString()} events</em></div>`).join('') || '<p>No waiting threads detected.</p>'}</div>
                    </div>
                    <div class="panel">
                         <div class="panel-header"><div class="panel-title"><div class="icon">L</div>HOT RESOURCES</div></div>
                         <div class="ai-table">${report.hotResources.map(([name, r]) => `<div><span>${name}</span><b>${formatUs(r.wait)}</b><em>${r.events.toLocaleString()} events</em></div>`).join('') || '<p>No lock resources detected.</p>'}</div>
                    </div>
               </div>

               <div class="panel">
                    <div class="panel-header"><div class="panel-title"><div class="icon">✓</div>HOW TO CORRECT DETECTED PROBLEMS</div></div>
                    <ol class="ai-list">${(report.corrections.length ? report.corrections : ['No critical correction is required by the current rules; continue by validating hot phases in Timeline and Profiler.']).map(x => `<li>${x}</li>`).join('')}</ol>
               </div>

               <div class="panel">
                    <div class="panel-header"><div class="panel-title"><div class="icon">≡</div>WHAT THE DATA CONTAINS</div></div>
                    <div class="ai-chip-row">
                         ${report.topEvents.map(([ev, n]) => `<span>${eventLabel(ev)} <b>${n.toLocaleString()}</b></span>`).join('')}
                    </div>
                    <div class="ai-chip-row">
                         ${report.busiestScenarios.map(([sc, n]) => `<span>${String(sc).replace(/_/g, ' ')} <b>${n.toLocaleString()}</b></span>`).join('')}
                    </div>
               </div>
          `;
     }

     function init(data) {
          allData = data || [];
          loadSettingsIntoForm();
          renderReport();
          bindControls();
     }

     function triggerResize() {
          // Report is HTML/CSS driven; this hook keeps navigation resize calls safe.
     }

     function bindControls() {
          document.getElementById('btn-generate-report')?.addEventListener('click', renderReport);
          document.getElementById('btn-save-ai-key')?.addEventListener('click', saveSettings);
          document.getElementById('btn-clear-ai-key')?.addEventListener('click', clearSettings);
          document.getElementById('ai-provider')?.addEventListener('change', saveSettings);
     }

     document.addEventListener('DOMContentLoaded', () => {
          loadSettingsIntoForm();
          bindControls();
     });

     return { init, triggerResize, renderReport };
})();
