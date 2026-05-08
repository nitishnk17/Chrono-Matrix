/**
 * aireport.js — local trace report generator
 *
 * Produces a deterministic diagnostic report from the loaded trace.
 * When model settings are saved, it can also ask an external AI provider
 * for a narrative optimization report.
 */

const AIReport = (() => {
     let allData = [];
     const STORAGE_KEY = 'cm_ai_model_settings';
     let controlsBound = false;

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

     function escapeHTML(value) {
          return String(value ?? '').replace(/[&<>"']/g, ch => ({
               '&': '&amp;',
               '<': '&lt;',
               '>': '&gt;',
               '"': '&quot;',
               "'": '&#39;'
          }[ch]));
     }

     function stripMarkdownNumbering(value) {
          return String(value || '').replace(/^\s*(?:\d+[\).]|[-*•])\s*/, '').trim();
     }

     function inlineMarkdownToHTML(value) {
          return escapeHTML(value || '')
               .replace(/`([^`]+)`/g, '<code>$1</code>')
               .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
               .replace(/\*([^*]+)\*/g, '<em>$1</em>');
     }

     function compactReportForModel(report) {
          const s = report.summary;
          return {
               summary: {
                    events: s.events,
                    threads: s.threads,
                    scenarios: s.scenarios,
                    trace_window_us: Math.round(s.duration),
                    compute_time_us: Math.round(s.computeTime),
                    wait_time_us: Math.round(s.waitTime),
                    wait_share: pct(s.waitTime, s.totalThreadTime),
                    lock_wait_events: s.lockWaits,
                    timeouts: s.timeouts,
                    deadlocks: s.deadlocks,
                    memory_events: s.memoryEvents
               },
               top_events: report.topEvents.map(([event, count]) => ({ event, count })),
               top_waiting_threads: report.topThreads.map(([tid, t]) => ({
                    tid,
                    wait_us: Math.round(t.wait),
                    compute_us: Math.round(t.compute),
                    events: t.events,
                    memory_events: t.memory,
                    deadlocks: t.deadlocks
               })),
               hot_resources: report.hotResources.map(([resource, r]) => ({
                    resource,
                    wait_us: Math.round(r.wait),
                    events: r.events,
                    deadlocks: r.deadlocks,
                    timeouts: r.timeouts
               })),
               scenarios: report.busiestScenarios.map(([scenario, count]) => ({ scenario, count })),
               local_findings: report.issues,
               local_recommendations: report.recommendations,
               local_corrections: report.corrections
          };
     }

     function buildModelPrompt(report) {
          return `You are analyzing a Chrono-Matrix multithreaded execution trace.

Return a concise engineering report with these exact sections:
1. Overview of what the data contains
2. Problems detected and severity
3. Optimization plan
4. Concrete correction steps
5. What to verify after the next run

Be specific, practical, and do not invent measurements that are not in the JSON.

Trace summary JSON:
${JSON.stringify(compactReportForModel(report), null, 2)}`;
     }

     function getSettingsFromForm({ persist = false } = {}) {
          const previous = readSettings();
          const provider = document.getElementById('ai-provider')?.value || previous.provider || 'local';
          const model = document.getElementById('ai-model')?.value.trim() || previous.model || '';
          const endpoint = document.getElementById('ai-endpoint')?.value.trim() || previous.endpoint || '';
          const keyInput = document.getElementById('ai-api-key')?.value.trim() || '';
          const apiKey = keyInput || previous.apiKey || '';

          const settings = {
               provider,
               model,
               endpoint,
               hasKey: Boolean(apiKey),
               keyPreview: apiKey ? maskKey(apiKey) : '',
               apiKey
          };

          if (provider === 'local') {
               settings.hasKey = false;
               settings.keyPreview = '';
               settings.apiKey = '';
          }

          if (persist) {
               localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
               if (document.getElementById('ai-api-key')) document.getElementById('ai-api-key').value = '';
          }

          return settings;
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
          const settings = getSettingsFromForm({ persist: true });
          writeStatus(settings.hasKey ? `Saved ${settings.provider} settings (${settings.keyPreview})` : 'Using local rule-based report', settings.hasKey ? 'saved' : '');
          return settings;
     }

     function clearSettings() {
          localStorage.removeItem(STORAGE_KEY);
          loadSettingsIntoForm();
          writeStatus('AI key cleared. Local report mode is active.', 'cleared');
     }

     function providerDefaults(provider) {
          return {
               openai: {
                    endpoint: 'https://api.openai.com/v1/chat/completions',
                    model: 'gpt-4o-mini'
               },
               openrouter: {
                    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
                    model: 'openai/gpt-4o-mini'
               },
               anthropic: {
                    endpoint: 'https://api.anthropic.com/v1/messages',
                    model: 'claude-3-5-haiku-latest'
               },
               gemini: {
                    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
                    model: 'gemini-1.5-flash'
               },
               custom: {
                    endpoint: '',
                    model: ''
               }
          }[provider] || { endpoint: '', model: '' };
     }

     function validateRemoteSettings(settings) {
          if (!settings || settings.provider === 'local') return 'local';
          if (!settings.apiKey) return 'Add an API key or choose Local rules only.';
          if (!settings.model && !providerDefaults(settings.provider).model) return 'Add the model name for this provider.';
          if (settings.provider === 'custom' && !settings.endpoint) return 'Add an endpoint URL for the custom provider.';
          return '';
     }

     function messagesFor(prompt) {
          return [
               {
                    role: 'system',
                    content: 'You are a senior performance engineer. Write precise, practical optimization guidance for multithreaded C/C++ traces.'
               },
               { role: 'user', content: prompt }
          ];
     }

     async function parseJSONResponse(response, provider) {
          const text = await response.text();
          let json = null;
          try {
               json = text ? JSON.parse(text) : null;
          } catch {
               throw new Error(`The ${provider} endpoint did not return JSON. ${text.slice(0, 160)}`);
          }

          if (!response.ok) {
               const message = json?.error?.message || json?.error || json?.message || response.statusText;
               throw new Error(`${provider} request failed (${response.status}): ${message}`);
          }

          return json;
     }

     async function requestOpenAICompatible(settings, prompt, defaults = {}) {
          const endpoint = settings.endpoint || defaults.endpoint;
          const model = settings.model || defaults.model;
          const response = await fetch(endpoint, {
               method: 'POST',
               headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${settings.apiKey}`
               },
               body: JSON.stringify({
                    model,
                    messages: messagesFor(prompt),
                    temperature: 0.2,
                    max_tokens: 900
               })
          });
          const json = await parseJSONResponse(response, settings.provider);
          return json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text || '';
     }

     async function requestAnthropic(settings, prompt) {
          const defaults = providerDefaults('anthropic');
          const response = await fetch(settings.endpoint || defaults.endpoint, {
               method: 'POST',
               headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': settings.apiKey,
                    'anthropic-version': '2023-06-01',
                    'anthropic-dangerous-direct-browser-access': 'true'
               },
               body: JSON.stringify({
                    model: settings.model || defaults.model,
                    max_tokens: 900,
                    temperature: 0.2,
                    messages: [{ role: 'user', content: prompt }]
               })
          });
          const json = await parseJSONResponse(response, 'anthropic');
          return (json?.content || []).map(part => part.text || '').join('\n').trim();
     }

     async function requestGemini(settings, prompt) {
          const defaults = providerDefaults('gemini');
          const base = (settings.endpoint || defaults.endpoint).replace(/\/$/, '');
          const model = encodeURIComponent(settings.model || defaults.model);
          const url = `${base}/models/${model}:generateContent?key=${encodeURIComponent(settings.apiKey)}`;
          const response = await fetch(url, {
               method: 'POST',
               headers: { 'Content-Type': 'application/json' },
               body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: {
                         temperature: 0.2,
                         maxOutputTokens: 900
                    }
               })
          });
          const json = await parseJSONResponse(response, 'gemini');
          return json?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('\n').trim() || '';
     }

     async function requestAIReport(settings, report) {
          const validation = validateRemoteSettings(settings);
          if (validation === 'local') return null;
          if (validation) throw new Error(validation);

          const prompt = buildModelPrompt(report);
          if (settings.provider === 'anthropic') return requestAnthropic(settings, prompt);
          if (settings.provider === 'gemini') return requestGemini(settings, prompt);
          if (settings.provider === 'openrouter') return requestOpenAICompatible(settings, prompt, providerDefaults('openrouter'));
          if (settings.provider === 'custom') return requestOpenAICompatible(settings, prompt, providerDefaults('custom'));
          return requestOpenAICompatible(settings, prompt, providerDefaults('openai'));
     }

     function renderModelText(text) {
          const source = String(text || '').trim();
          if (!source) return '<p>The model returned an empty response.</p>';
          return source
               .split(/\n{2,}/)
               .map(block => `<p>${inlineMarkdownToHTML(block).replace(/\n/g, '<br>')}</p>`)
               .join('');
     }

     function sectionTextToHTML(text) {
          const source = String(text || '').trim();
          if (!source) return '';
          const items = source
               .split(/\n+/)
               .map(stripMarkdownNumbering)
               .filter(Boolean);

          if (items.length > 1) {
               return `<ol class="ai-list">${items.map(item => `<li>${inlineMarkdownToHTML(item)}</li>`).join('')}</ol>`;
          }
          return `<div class="ai-model-text"><p>${inlineMarkdownToHTML(items[0] || source)}</p></div>`;
     }

     function parseAISections(text) {
          const sections = {
               overview: '',
               problems: '',
               optimization: '',
               corrections: '',
               verify: '',
               raw: text || ''
          };

          const headingMap = [
               ['overview', /overview|what the data contains/i],
               ['problems', /problem|severity|detected/i],
               ['optimization', /optimization|optimize|plan/i],
               ['corrections', /correction|correct|steps/i],
               ['verify', /verify|next run|validation/i]
          ];
          let current = 'overview';

          String(text || '').split('\n').forEach(line => {
               const cleaned = line.replace(/^\s*\d+[\).:-]?\s*/, '').replace(/^#+\s*/, '').trim();
               const matched = headingMap.find(([, rx]) => rx.test(cleaned) && cleaned.length < 90);
               if (matched) {
                    current = matched[0];
                    return;
               }
               if (!sections[current]) sections[current] = '';
               sections[current] += `${line}\n`;
          });

          Object.keys(sections).forEach(key => {
               sections[key] = String(sections[key] || '').trim();
          });
          return sections;
     }

     function modelPanel({ state, provider, model, text, error }) {
          if (state === 'loading') {
               return `<div class="panel ai-model-panel ai-loading">
                    <div class="panel-header"><div class="panel-title"><div class="icon">AI</div>MODEL REPORT</div><span class="panel-meta">Contacting ${escapeHTML(provider)}...</span></div>
                    <p>Generating provider-backed analysis from the loaded trace. The local report below is already available.</p>
               </div>`;
          }

          if (state === 'error') {
               return `<div class="panel ai-model-panel ai-error">
                    <div class="panel-header"><div class="panel-title"><div class="icon">!</div>MODEL REQUEST FAILED</div><span class="panel-meta">Local fallback shown</span></div>
                    <p>${escapeHTML(error)}</p>
                    <p class="ai-report-note">If this is a browser CORS error, use a custom backend proxy endpoint and select Custom / OpenAI-compatible. API keys in browser localStorage are convenient for demos, not production-safe.</p>
               </div>`;
          }

          if (!text) return '';
          return `<div class="panel ai-model-panel">
               <div class="panel-header"><div class="panel-title"><div class="icon">AI</div>MODEL REPORT</div><span class="panel-meta">${escapeHTML(provider)} · ${escapeHTML(model)}</span></div>
               <div class="ai-model-text">${renderModelText(text)}</div>
          </div>`;
     }

     function renderLocalReport(report, settings, modelBlock = '', aiText = '') {
          const content = document.getElementById('ai-report-content');
          const status = document.getElementById('ai-report-status');
          if (!content) return;
          const s = report.summary;
          const aiSections = aiText ? parseAISections(aiText) : null;
          const modeLabel = settings.hasKey && settings.provider !== 'local'
               ? (aiText ? `${settings.provider} AI generated` : `${settings.provider} settings saved`)
               : 'local analysis';
          if (status) status.textContent = `${s.events.toLocaleString()} events analyzed · ${report.issues.length} finding${report.issues.length === 1 ? '' : 's'} · ${modeLabel}`;

          const diagnosisHTML = aiSections?.problems
               ? sectionTextToHTML(aiSections.problems)
               : `<div class="ai-finding-list">
                    ${report.issues.map(issue => `<div class="ai-finding ${issue.level}">
                         <b>${issue.title}</b>
                         <p>${issue.body}</p>
                    </div>`).join('')}
               </div>`;

          const optimizationHTML = aiSections?.optimization
               ? sectionTextToHTML(aiSections.optimization)
               : `<ol class="ai-list">${report.recommendations.map(x => `<li>${x}</li>`).join('')}</ol>`;

          const correctionHTML = aiSections?.corrections
               ? sectionTextToHTML(aiSections.corrections)
               : `<ol class="ai-list">${(report.corrections.length ? report.corrections : ['No critical correction is required by the current rules; continue by validating hot phases in Timeline and Profiler.']).map(x => `<li>${x}</li>`).join('')}</ol>`;

          const overviewHTML = aiSections?.overview
               ? `<div class="ai-model-text">${renderModelText(aiSections.overview)}</div>`
               : `<div class="ai-chip-row">
                    ${report.topEvents.map(([ev, n]) => `<span>${eventLabel(ev)} <b>${n.toLocaleString()}</b></span>`).join('')}
               </div>
               <div class="ai-chip-row">
                    ${report.busiestScenarios.map(([sc, n]) => `<span>${String(sc).replace(/_/g, ' ')} <b>${n.toLocaleString()}</b></span>`).join('')}
               </div>`;

          const verifyHTML = aiSections?.verify
               ? `<div class="panel ai-model-panel">
                    <div class="panel-header"><div class="panel-title"><div class="icon">✓</div>WHAT TO VERIFY AFTER NEXT RUN</div><span class="panel-meta">AI generated</span></div>
                    ${sectionTextToHTML(aiSections.verify)}
               </div>`
               : '';

          content.innerHTML = `
               ${modelBlock}

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
                         <div class="panel-header"><div class="panel-title"><div class="icon">!</div>${aiText ? 'AI PROBLEM DIAGNOSIS' : 'PROBLEM DIAGNOSIS'}</div><span class="panel-meta">${aiText ? 'model generated' : 'local rules'}</span></div>
                         ${diagnosisHTML}
                    </div>
                    <div class="panel">
                         <div class="panel-header"><div class="panel-title"><div class="icon">↗</div>${aiText ? 'AI OPTIMIZATION PLAN' : 'OPTIMIZATION PLAN'}</div><span class="panel-meta">${aiText ? 'model generated' : 'local rules'}</span></div>
                         ${optimizationHTML}
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
                    <div class="panel-header"><div class="panel-title"><div class="icon">✓</div>${aiText ? 'AI CORRECTION STEPS' : 'HOW TO CORRECT DETECTED PROBLEMS'}</div><span class="panel-meta">${aiText ? 'model generated' : 'local rules'}</span></div>
                    ${correctionHTML}
               </div>

               ${verifyHTML}

               <div class="panel">
                    <div class="panel-header"><div class="panel-title"><div class="icon">≡</div>${aiText ? 'AI DATA OVERVIEW' : 'WHAT THE DATA CONTAINS'}</div><span class="panel-meta">${aiText ? 'model generated' : 'local summary'}</span></div>
                    ${overviewHTML}
               </div>
          `;
     }

     async function renderReport() {
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
          const settings = getSettingsFromForm({ persist: true });
          writeStatus(settings.hasKey ? `Saved ${settings.provider} settings (${settings.keyPreview})` : 'Using local rule-based report', settings.hasKey ? 'saved' : '');

          if (!settings.hasKey || settings.provider === 'local') {
               renderLocalReport(report, settings);
               return;
          }

          const modelName = settings.model || providerDefaults(settings.provider).model || 'model';
          renderLocalReport(report, settings, modelPanel({ state: 'loading', provider: settings.provider, model: modelName }));

          try {
               const text = await requestAIReport(settings, report);
               renderLocalReport(
                    report,
                    settings,
                    modelPanel({
                         state: 'ready',
                         provider: settings.provider,
                         model: modelName,
                         text: 'AI response applied to the report sections below.'
                    }),
                    text
               );
          } catch (err) {
               renderLocalReport(report, settings, modelPanel({ state: 'error', error: err?.message || String(err) }));
               if (status) status.textContent = `${report.summary.events.toLocaleString()} events analyzed · model request failed · local fallback`;
          }
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
          if (controlsBound) return;
          controlsBound = true;
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
