/**
 * flow3d.js — Event Flow Particle Stream Visualization Module
 * Integrates the real-time event flow into Chrono-Matrix as a native page.
 * Receives already-parsed trace data from main.js, no independent fetch needed.
 */

const FlowViz = (() => {
    const EV_COL = EventBus.colors;
    const SPEEDS = [0.5, 1, 2, 4];
    const SPD_LBL = ['½×', '1×', '2×', '4×'];

    let traceData = [], TIDS = [], TS_MIN = 0, TS_SPAN = 1;
    let W = 0, H = 0, LANE_H = 0;
    let canvas = null, ctx = null;
    let particles = [], playing = true, running = false, playPos = 0, frame = 0;
    let totalStreamed = 0, dlPulses = 0;
    let filterEv = 'all', spdIdx = 1;
    let lastTime = 0, animId = null;
    let streamEvents = [], evIdx = 0;
    let burstCount = 0;
    const dl_waves = [];
    let initialized = false;

    function resize() {
        const container = document.getElementById('flow3d-canvas-wrap');
        if (!container || !canvas) return;
        W = container.clientWidth;
        H = container.clientHeight;
        canvas.width = W;
        canvas.height = H;
        LANE_H = Math.max(14, Math.floor(H / Math.min(TIDS.length, 40)));
    }

    function spawnParticles(pos) {
        const lo = TS_MIN + pos * TS_SPAN;
        const hi = TS_MIN + (pos + 0.0025) * TS_SPAN;
        while (evIdx < streamEvents.length && streamEvents[evIdx].ts <= hi) {
            const e = streamEvents[evIdx]; evIdx++;
            if (e.ts < lo) continue;
            if (filterEv !== 'all' && e.event !== filterEv) continue;
            const ti = TIDS.indexOf(e.tid);
            if (ti < 0) continue;
            const y = ti * LANE_H + LANE_H / 2;
            const w = Math.max(3, Math.min(30, Math.log(1 + e.duration_us) * 3));
            const col = EV_COL[e.event] || '#fff';
            particles.push({
                x: 12 + Math.random() * 10, y, vy: (Math.random() - .5) * 0.3,
                speed: 1.5 + Math.random() * 1.5, w, h: Math.max(3, LANE_H * 0.45),
                col, event: e.event, tid: e.tid, dur: e.duration_us, scenario: e.scenario,
                life: 1, decay: 0.003 + Math.random() * 0.002,
                trail: [], dead: e.event === 'DEADLOCK_DETECTED', alpha: 0.9
            });
            totalStreamed++;
            if (e.event === 'DEADLOCK_DETECTED') dlPulses++;
        }
    }

    function draw() {
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#00030a'; ctx.fillRect(0, 0, W, H);

        const LABEL_W = 34;
        TIDS.slice(0, Math.floor(H / LANE_H)).forEach((tid, ti) => {
            const y = ti * LANE_H;
            ctx.fillStyle = ti % 2 === 0 ? 'rgba(0,12,20,0.55)' : 'rgba(0,8,14,0.55)';
            ctx.fillRect(0, y, W, LANE_H);
            ctx.fillStyle = 'rgba(0,6,12,0.85)'; ctx.fillRect(0, y, LABEL_W, LANE_H);
            ctx.font = 'bold 9px Orbitron, monospace';
            ctx.fillStyle = 'rgba(88,166,255,0.75)';
            ctx.fillText('T' + tid, 3, y + LANE_H * 0.68);
            ctx.strokeStyle = 'rgba(10,50,40,0.5)'; ctx.lineWidth = 0.5;
            ctx.beginPath(); ctx.moveTo(LABEL_W, y + LANE_H); ctx.lineTo(W, y + LANE_H); ctx.stroke();
            ctx.strokeStyle = 'rgba(88,166,255,0.12)'; ctx.lineWidth = 0.5;
            ctx.beginPath(); ctx.moveTo(LABEL_W, y); ctx.lineTo(LABEL_W, y + LANE_H); ctx.stroke();
        });

        if (H > 100) {
            ctx.font = 'bold 9px Orbitron, monospace';
            ctx.fillStyle = 'rgba(88,166,255,0.2)';
            ctx.fillText('← OLDER                                     NEWER →', LABEL_W + 10, H - 6);
        }

        for (let i = dl_waves.length - 1; i >= 0; i--) {
            const wv = dl_waves[i]; wv.r += 3; wv.life -= 0.03;
            ctx.strokeStyle = `rgba(225,29,72,${wv.life * 0.6})`; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(wv.x, wv.y, wv.r, 0, Math.PI * 2); ctx.stroke();
            if (wv.life <= 0 || wv.r > 300) dl_waves.splice(i, 1);
        }

        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            p.x += p.speed; p.y += p.vy; p.life -= p.decay;
            if (p.life <= 0 || p.x > W) { particles.splice(i, 1); continue; }
            if (frame % 2 === 0) p.trail.push({ x: p.x, y: p.y });
            if (p.trail.length > 18) p.trail.shift();
            if (p.trail.length > 1) {
                ctx.beginPath();
                p.trail.forEach((pt, j) => {
                    ctx.globalAlpha = (j / p.trail.length) * p.life * 0.35;
                    if (j === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y);
                });
                ctx.strokeStyle = p.col; ctx.lineWidth = p.h * 0.3; ctx.stroke();
            }
            ctx.globalAlpha = p.life * p.alpha;
            if (p.dead || p.event === 'LOCK_WAIT') { ctx.shadowColor = p.col; ctx.shadowBlur = 8; }
            ctx.fillStyle = p.col;
            ctx.beginPath();
            const rr = 2;
            ctx.moveTo(p.x - p.w + rr, p.y - p.h / 2);
            ctx.lineTo(p.x + rr, p.y - p.h / 2);
            ctx.arcTo(p.x + p.w / 2, p.y - p.h / 2, p.x + p.w / 2, p.y, rr);
            ctx.arcTo(p.x + p.w / 2, p.y + p.h / 2, p.x + rr, p.y + p.h / 2, rr);
            ctx.lineTo(p.x - p.w + rr, p.y + p.h / 2);
            ctx.arcTo(p.x - p.w, p.y + p.h / 2, p.x - p.w, p.y, rr);
            ctx.arcTo(p.x - p.w, p.y - p.h / 2, p.x - p.w + rr, p.y - p.h / 2, rr);
            ctx.closePath(); ctx.fill();
            ctx.shadowBlur = 0; ctx.globalAlpha = 1;
            if (p.dead && Math.random() < 0.04) dl_waves.push({ x: p.x, y: p.y, r: p.h, life: 1 });
        }

        if (burstCount > 0) {
            for (let b = 0; b < 15; b++) {
                const ti = Math.floor(Math.random() * Math.min(TIDS.length, 40));
                const evT = ['COMPUTE', 'LOCK_WAIT', 'LOCK_ACQUIRE', 'DEADLOCK_DETECTED'];
                const ev = evT[Math.floor(Math.random() * evT.length)];
                const y = ti * LANE_H + LANE_H / 2;
                particles.push({ x: Math.random() * 40, y, vy: (Math.random() - .5) * 0.5, speed: 2 + Math.random() * 2, w: 6 + Math.random() * 10, h: Math.max(4, LANE_H * 0.5), col: EV_COL[ev], event: ev, tid: TIDS[ti], dur: 100, scenario: 'burst', life: 1, decay: 0.008, trail: [], dead: ev === 'DEADLOCK_DETECTED', alpha: 0.95 });
                totalStreamed++;
            }
            burstCount--;
        }

        ctx.strokeStyle = 'rgba(88,166,255,0.3)'; ctx.lineWidth = 1; ctx.setLineDash([5, 6]);
        ctx.beginPath(); ctx.moveTo(30, 0); ctx.lineTo(30, H); ctx.stroke(); ctx.setLineDash([]);

        if (frame % 30 === 0) {
            const el = id => document.getElementById(id);
            if (el('fl-rate')) el('fl-rate').textContent = particles.length.toLocaleString();
            if (el('fl-total')) el('fl-total').textContent = totalStreamed.toLocaleString();
            if (el('fl-dl')) el('fl-dl').textContent = dlPulses.toLocaleString();
            const ts = TS_MIN + playPos * TS_SPAN;
            if (el('fl-time-lbl')) el('fl-time-lbl').textContent = 't = ' + Math.round(ts).toLocaleString() + ' µs';
            const slider = document.getElementById('fl-tl-slider');
            if (slider) slider.value = Math.round(playPos * 1000);
        }
    }

    function animate(ts = 0) {
        if (!running) { animId = null; return; }
        animId = requestAnimationFrame(animate);
        const dt = Math.min((ts - lastTime) / 1000, 0.05); lastTime = ts; frame++;
        if (!playing) return;
        playPos = Math.min(1, (playPos + dt * 0.018 * SPEEDS[spdIdx]));
        if (playPos >= 1) { playPos = 0; evIdx = 0; }
        const slider = document.getElementById('fl-tl-slider');
        if (slider) slider.value = Math.round(playPos * 1000);
        spawnParticles(playPos);
        draw();
    }

    function buildBreakdown() {
        const EXCLUDED = new Set(['THREAD_START', 'THREAD_END', 'THREAD_JOIN', 'COND_WAIT']);
        const byEvent = {};
        traceData.forEach(e => { if (!EXCLUDED.has(e.event)) byEvent[e.event] = (byEvent[e.event] || 0) + 1; });
        const total = Object.values(byEvent).reduce((s, n) => s + n, 0) || 1;
        const eb = document.getElementById('fl-ev-breakdown');
        if (!eb) return;
        eb.innerHTML = Object.entries(byEvent).map(([ev, n]) => `
            <div style="display:flex;align-items:center;gap:7px;margin-bottom:6px">
                <div style="width:9px;height:9px;border-radius:50%;background:${EV_COL[ev] || '#fff'};box-shadow:0 0 4px ${EV_COL[ev] || '#fff'};flex-shrink:0"></div>
                <span style="font-size:0.62rem;color:var(--text-secondary);flex:1">${EventBus.label(ev)}</span>
                <span style="font-family:var(--font-code);font-size:0.58rem;color:var(--cyan)">${n.toLocaleString()}</span>
            </div>
            <div style="height:3px;background:rgba(255,255,255,.05);border-radius:2px;margin-bottom:7px">
                <div style="height:100%;background:${EV_COL[ev] || '#fff'};width:${Math.round(n / total * 100)}%;border-radius:2px"></div>
            </div>
        `).join('');
    }

    function init(data) {
        traceData = data;
        TIDS = [...new Set(data.map(e => e.tid))].sort((a, b) => a - b);
        TS_MIN = data.reduce((m, e) => e.ts < m ? e.ts : m, data[0].ts);
        const TS_MAX = data.reduce((m, e) => e.ts > m ? e.ts : m, data[0].ts);
        TS_SPAN = TS_MAX - TS_MIN || 1;
        const EXCLUDED = new Set(['THREAD_START', 'THREAD_END', 'THREAD_JOIN', 'COND_WAIT']);
        streamEvents = data.filter(e => !EXCLUDED.has(e.event)).sort((a, b) => a.ts - b.ts);
        initialized = true;
    }

    function start() {
        if (!initialized) return;
        canvas = document.getElementById('flow3d-canvas');
        if (!canvas) return;
        ctx = canvas.getContext('2d');
        playing = true; running = true; playPos = 0; frame = 0; evIdx = 0;
        totalStreamed = 0; dlPulses = 0; burstCount = 0;
        particles.length = 0; dl_waves.length = 0;
        // Defer one frame so flexbox layout is complete before reading clientWidth/Height
        requestAnimationFrame(() => { resize(); });
        buildBreakdown();

        const playBtn = document.getElementById('fl-play-btn');
        if (playBtn) playBtn.onclick = () => { playing = !playing; playBtn.textContent = playing ? '⏸ PAUSE' : '▶ PLAY'; };

        const burstBtn = document.getElementById('fl-burst-btn');
        if (burstBtn) burstBtn.onclick = () => { burstCount = 60; };

        const spdBtn = document.getElementById('fl-speed-btn');
        if (spdBtn) spdBtn.onclick = function () { spdIdx = (spdIdx + 1) % SPEEDS.length; this.textContent = SPD_LBL[spdIdx] + ' SPEED'; };

        const filterSel = document.getElementById('fl-filter-sel');
        if (filterSel) filterSel.onchange = e => { filterEv = e.target.value; particles.length = 0; evIdx = Math.floor(playPos * streamEvents.length); };

        const slider = document.getElementById('fl-tl-slider');
        if (slider) slider.oninput = () => { playPos = slider.value / 1000; evIdx = Math.floor(playPos * streamEvents.length); particles.length = 0; };

        // Tooltip on canvas
        canvas.onmousemove = e => {
            const rect = canvas.getBoundingClientRect();
            const rx = e.clientX - rect.left, ry = e.clientY - rect.top;
            const hit = particles.find(p => Math.abs(p.x - rx) < p.w + 4 && Math.abs(p.y - ry) < p.h + 3);
            const ttp = document.getElementById('fl-tooltip');
            if (hit && ttp) {
                const descs = { COMPUTE: 'Thread is actively computing', LOCK_ACQUIRE: 'Grabbed a mutex lock', LOCK_WAIT: 'Blocked - waiting for lock', LOCK_WAIT_TIMEOUT: 'Timed out while waiting for lock', LOCK_RELEASE: 'Released mutex lock', DEADLOCK_DETECTED: 'Deadlock detected', MEM_READ: 'Read shared memory', MEM_WRITE: 'Wrote shared memory', MEM_ALLOC: 'Allocated memory', MEM_FREE: 'Freed memory' };
                document.getElementById('fl-tt-n').textContent = EventBus.label(hit.event);
                document.getElementById('fl-tt-t').textContent = 'T' + hit.tid;
                document.getElementById('fl-tt-e').textContent = descs[hit.event] || hit.event;
                document.getElementById('fl-tt-d').textContent = hit.dur.toLocaleString() + ' µs';
                document.getElementById('fl-tt-s').textContent = (hit.scenario || 'uncategorized').replace(/_/g, '-');
                ttp.style.display = 'block';
                EventBus.positionTooltip(ttp, e);
            } else if (ttp) ttp.style.display = 'none';
        };
        canvas.onmouseleave = () => { const t = document.getElementById('fl-tooltip'); if (t) t.style.display = 'none'; };

        if (animId) cancelAnimationFrame(animId);
        lastTime = 0;
        animate();
    }

    function stop() {
        running = false;
        if (animId) { cancelAnimationFrame(animId); animId = null; }
    }

    return { init, start, stop, resize };
})();
