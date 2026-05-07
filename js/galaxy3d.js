/**
 * galaxy3d.js — Thread Galaxy 3D Visualization Module
 * Integrates the cosmic galaxy view into Chrono-Matrix as a native page.
 * Receives already-parsed trace data from main.js, no independent fetch needed.
 */

const GalaxyViz = (() => {
    const SC_COL = {
        compute: '#38bdf8',
        critical: '#22c55e',
        contention: '#f97316',
        'cache-contention': '#fb7185',
        'cache-evict': '#a3e635',
        'gc-pause': '#c084fc',
        'deadlock-demo': '#ef4444',
        io: '#06b6d4',
        'io-contention': '#f59e0b',
        sync: '#14b8a6',
        dispatch: '#60a5fa',
        startup: '#94a3b8',
        shutdown: '#64748b'
    };
    const SC_FALLBACK = ['#38bdf8', '#22c55e', '#f97316', '#c084fc', '#f43f5e', '#14b8a6', '#eab308', '#60a5fa'];
    const GALAXY_COL = {
        COMPUTE: '#38bdf8',
        LOCK_ACQUIRE: '#34d399',
        LOCK_WAIT: '#f59e0b',
        DEADLOCK_DETECTED: '#ef4444'
    };
    let traceData = [], sortedTrace = [], TIDS = [], TS_MIN = 0, TS_SPAN = 1;
    let stars = [], nebulae = [], bgStars = [];
    let playing = true, running = false, playPos = 0, animId = null;
    let W = 0, H = 0;
    let canvas = null, ctx = null;
    let frame = 0, lastTime = 0;
    let initialized = false;

    function hashString(input) {
        let hash = 2166136261;
        for (let i = 0; i < input.length; i++) {
            hash ^= input.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return hash >>> 0;
    }

    function scenarioColor(scenario) {
        if (SC_COL[scenario]) return SC_COL[scenario];
        return SC_FALLBACK[hashString(scenario || 'unknown') % SC_FALLBACK.length];
    }

    function dominantKey(counts, fallback = '') {
        const entries = Object.entries(counts || {});
        if (!entries.length) return fallback;
        return entries.sort((a, b) => b[1] - a[1])[0][0];
    }

    function legendEvent(event) {
        if (event === 'DEADLOCK_DETECTED') return 'DEADLOCK_DETECTED';
        if (event === 'LOCK_WAIT') return 'LOCK_WAIT';
        if (event === 'LOCK_ACQUIRE') return 'LOCK_ACQUIRE';
        return 'COMPUTE';
    }

    function buildGalaxy() {
        const container = document.getElementById('galaxy3d-canvas-wrap');
        if (!container) return;
        W = container.clientWidth;
        H = container.clientHeight;
        canvas.width = W;
        canvas.height = H;

        bgStars = [];
        for (let i = 0; i < 260; i++) {
            bgStars.push({ x: Math.random() * W, y: Math.random() * H, r: Math.random() * 0.9 + 0.25, alpha: Math.random() * 0.35 + 0.08 });
        }

        const threadStats = {};
        TIDS.forEach(tid => {
            threadStats[tid] = { count: 0, waits: 0, scenarioCounts: {}, eventCounts: {}, scenario: '', deadlocks: 0, lastEvent: 'COMPUTE' };
        });
        traceData.forEach(e => {
            if (!threadStats[e.tid]) return;
            const st = threadStats[e.tid];
            threadStats[e.tid].count++;
            st.scenarioCounts[e.scenario] = (st.scenarioCounts[e.scenario] || 0) + 1;
            st.eventCounts[e.event] = (st.eventCounts[e.event] || 0) + 1;
            st.lastEvent = e.event;
            if (e.event === 'LOCK_WAIT') st.waits++;
            if (e.event === 'DEADLOCK_DETECTED') st.deadlocks++;
        });
        Object.values(threadStats).forEach(st => {
            st.scenario = dominantKey(st.scenarioCounts, 'uncategorized');
            st.dominantEvent = dominantKey(st.eventCounts, st.lastEvent || 'COMPUTE');
        });

        const cx = W / 2, cy = H / 2;
        const maxCount = Math.max(1, ...Object.values(threadStats).map(t => t.count));
        stars = [];
        TIDS.forEach((tid, i) => {
            const frac = i / Math.max(TIDS.length - 1, 1);
            const armAngle = (frac * Math.PI * 4) + (Math.floor(i % 3) * Math.PI * 2 / 3);
            const radius = 60 + frac * Math.min(cx, cy) * 0.72;
            const wobble = (Math.random() - .5) * 25;
            const sx = cx + Math.cos(armAngle) * (radius + wobble);
            const sy = cy + Math.sin(armAngle) * (radius + wobble) * 0.6;
            const st = threadStats[tid];
            const size = 3 + ((st.count / maxCount) * 12);
            const baseCol = scenarioColor(st.scenario);
            stars.push({
                tid, sx, sy, tx: sx, ty: sy, baseCol, size,
                count: st.count, waits: st.waits, deadlocks: st.deadlocks, scenario: st.scenario,
                lastEvent: st.lastEvent, dominantEvent: st.dominantEvent, angle: armAngle, orbitR: radius,
                phase: Math.random() * Math.PI * 2, pulsePhase: Math.random() * Math.PI * 2,
                cx, cy, particles: [], dead: st.deadlocks > 0
            });
        });

        const scGroups = {};
        stars.forEach(s => { if (!scGroups[s.scenario]) scGroups[s.scenario] = []; scGroups[s.scenario].push(s); });
        nebulae = [];
        Object.entries(scGroups).forEach(([sc, slist]) => {
            const avgX = slist.reduce((a, s) => a + s.sx, 0) / slist.length;
            const avgY = slist.reduce((a, s) => a + s.sy, 0) / slist.length;
            nebulae.push({ x: avgX, y: avgY, r: Math.max(50, slist.length * 12), col: scenarioColor(sc), label: sc.replace(/_/g, ' ').toUpperCase() });
        });
    }

    function draw() {
        const t = frame * 0.02;
        ctx.clearRect(0, 0, W, H);
        const bg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.78);
        bg.addColorStop(0, '#14213d');
        bg.addColorStop(0.42, '#07111f');
        bg.addColorStop(1, '#020617');
        ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

        const vignette = ctx.createLinearGradient(0, 0, 0, H);
        vignette.addColorStop(0, 'rgba(56, 189, 248, 0.10)');
        vignette.addColorStop(0.52, 'rgba(15, 23, 42, 0.02)');
        vignette.addColorStop(1, 'rgba(2, 6, 23, 0.44)');
        ctx.fillStyle = vignette;
        ctx.fillRect(0, 0, W, H);

        bgStars.forEach(s => {
            ctx.globalAlpha = s.alpha * (0.7 + Math.sin(frame * 0.015 + s.x) * 0.3);
            ctx.fillStyle = '#dbeafe';
            ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
        });
        ctx.globalAlpha = 1;

        const wSize = 0.035;
        const lo = TS_MIN + playPos * TS_SPAN, hi = lo + wSize * TS_SPAN;
        const inWindow = new Set(), dlInWindow = new Set(), activeEventByTid = new Map();
        let start_i = 0, lo_i = 0, hi_i = sortedTrace.length - 1;
        while (lo_i <= hi_i) { const mid = (lo_i + hi_i) >> 1; if (sortedTrace[mid].ts < lo) { start_i = mid + 1; lo_i = mid + 1; } else hi_i = mid - 1; }
        for (let i = start_i; i < sortedTrace.length && sortedTrace[i].ts <= hi; i++) {
            const e = sortedTrace[i]; inWindow.add(e.tid);
            // Use the newest event in a tight time window so color reflects the current state,
            // not any severe wait that happened earlier in a broad window.
            activeEventByTid.set(e.tid, e.event);
            if (e.event === 'DEADLOCK_DETECTED') dlInWindow.add(e.tid);
        }

        nebulae.forEach(neb => {
            const g = ctx.createRadialGradient(neb.x, neb.y, 0, neb.x, neb.y, neb.r);
            g.addColorStop(0, neb.col + '38'); g.addColorStop(0.55, neb.col + '12'); g.addColorStop(1, 'transparent');
            ctx.fillStyle = g; ctx.globalAlpha = 0.78 + Math.sin(t * 0.5) * 0.08;
            ctx.beginPath(); ctx.arc(neb.x, neb.y, neb.r, 0, Math.PI * 2); ctx.fill();
            ctx.globalAlpha = 1;
            ctx.font = '800 10px Orbitron, monospace';
            ctx.fillStyle = neb.col; ctx.textAlign = 'center';
            ctx.shadowColor = '#020617';
            ctx.shadowBlur = 5;
            ctx.fillText(neb.label, neb.x, neb.y - neb.r * 0.7);
            ctx.shadowBlur = 0;
            ctx.textAlign = 'left';
        });

        stars.forEach(star => {
            ctx.beginPath();
            ctx.ellipse(star.cx, star.cy, star.orbitR, star.orbitR * 0.6, 0, 0, Math.PI * 2);
            ctx.strokeStyle = inWindow.has(star.tid) ? star.baseCol + '55' : 'rgba(148,163,184,0.16)';
            ctx.lineWidth = inWindow.has(star.tid) ? 1.1 : 0.6;
            ctx.setLineDash([5, 9]); ctx.stroke(); ctx.setLineDash([]);
        });

        stars.forEach(star => {
            const active = inWindow.has(star.tid), dead = dlInWindow.has(star.tid);
            const activeEvent = activeEventByTid.get(star.tid);
            const wobble = Math.sin(t * 0.4 + star.phase) * 8;
            star.tx = star.cx + Math.cos(star.angle + t * 0.05) * (star.orbitR + wobble);
            star.ty = star.cy + Math.sin(star.angle + t * 0.05) * (star.orbitR + wobble) * 0.6;
            star.sx += (star.tx - star.sx) * 0.04; star.sy += (star.ty - star.sy) * 0.04;

            const pulse = active ? (0.85 + Math.sin(t * 4 + star.pulsePhase) * 0.15) : 0.6;
            const sz = star.size * pulse * (dead ? 1.4 : 1);
            const glowR = sz * 4 + (active ? sz * 4 : 0);
            const legendState = activeEvent ? legendEvent(activeEvent) : null;
            const col = dead ? GALAXY_COL.DEADLOCK_DETECTED : (legendState ? GALAXY_COL[legendState] : star.baseCol);
            const glow = ctx.createRadialGradient(star.sx, star.sy, 0, star.sx, star.sy, glowR);
            glow.addColorStop(0, col + (active ? 'f2' : 'aa'));
            glow.addColorStop(0.34, col + (active ? '55' : '32'));
            glow.addColorStop(1, 'transparent');
            ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(star.sx, star.sy, glowR, 0, Math.PI * 2); ctx.fill();

            ctx.fillStyle = 'rgba(2, 6, 23, 0.92)';
            ctx.beginPath(); ctx.arc(star.sx, star.sy, sz + 3.5, 0, Math.PI * 2); ctx.fill();

            ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = active ? 18 : 9;
            ctx.beginPath(); ctx.arc(star.sx, star.sy, sz, 0, Math.PI * 2); ctx.fill();
            ctx.shadowBlur = 0;
            ctx.strokeStyle = active ? '#f8fafc' : 'rgba(226,232,240,0.58)';
            ctx.lineWidth = active ? 1.4 : 0.9;
            ctx.beginPath(); ctx.arc(star.sx, star.sy, sz + 0.5, 0, Math.PI * 2); ctx.stroke();

            if (dead) {
                const rPulse = sz + 4 + Math.sin(t * 6) * 3;
                ctx.strokeStyle = GALAXY_COL.DEADLOCK_DETECTED; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.6;
                ctx.beginPath(); ctx.arc(star.sx, star.sy, rPulse, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
            }

            ctx.font = '800 9px Orbitron, monospace';
            ctx.fillStyle = active ? '#f8fafc' : 'rgba(203,213,225,0.74)';
            ctx.shadowColor = '#020617';
            ctx.shadowBlur = 4;
            ctx.fillText('T' + star.tid, star.sx + sz + 3, star.sy + 3);
            ctx.shadowBlur = 0;

            if (active && Math.random() < 0.15) {
                const ang = Math.random() * Math.PI * 2;
                star.particles.push({ x: star.sx, y: star.sy, vx: Math.cos(ang) * (1 + Math.random() * 2), vy: Math.sin(ang) * (1 + Math.random() * 2), life: 1, col });
            }
            star.particles = star.particles.filter(p => {
                p.x += p.vx; p.y += p.vy; p.life -= 0.04;
                ctx.globalAlpha = p.life * 0.7; ctx.fillStyle = p.col;
                ctx.beginPath(); ctx.arc(p.x, p.y, 1.2, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
                return p.life > 0;
            });
        });

        if (frame % 20 === 0) {
            const activeArr = [...inWindow];
            for (let i = 0; i < Math.min(activeArr.length, 6); i++) {
                const s1 = stars.find(s => s.tid === activeArr[i]);
                const s2 = stars.find(s => s.tid === activeArr[(i + 1) % activeArr.length]);
                if (!s1 || !s2) continue;
                ctx.strokeStyle = s1.baseCol + '22'; ctx.lineWidth = 0.7;
                ctx.beginPath(); ctx.moveTo(s1.sx, s1.sy);
                const mx = (s1.sx + s2.sx) / 2, my = (s1.sy + s2.sy) / 2 - 30;
                ctx.quadraticCurveTo(mx, my, s2.sx, s2.sy); ctx.stroke();
            }
        }

        if (frame % 30 === 0) {
            const el = id => document.getElementById(id);
            if (el('gx-hud-stars')) el('gx-hud-stars').textContent = TIDS.length;
            if (el('gx-hud-active')) el('gx-hud-active').textContent = inWindow.size;
            if (el('gx-hud-dl')) el('gx-hud-dl').textContent = dlInWindow.size;
            if (el('gx-hud-time')) el('gx-hud-time').textContent = Math.round(lo / 1000) + 'ms';
            if (el('gx-progress')) el('gx-progress').style.width = (playPos * 100).toFixed(1) + '%';
            if (el('gx-time-lbl')) el('gx-time-lbl').textContent = 't = ' + Math.round(lo).toLocaleString() + ' µs';
        }
    }

    function animate(ts = 0) {
        if (!running) { animId = null; return; }
        animId = requestAnimationFrame(animate);
        const dt = Math.min((ts - lastTime) / 1000, 0.05); lastTime = ts; frame++;
        if (playing) { playPos = (playPos + dt * 0.04) % 1; }
        draw();
    }

    function resize() {
        const container = document.getElementById('galaxy3d-canvas-wrap');
        if (!container || !canvas) return;
        W = container.clientWidth; H = container.clientHeight;
        canvas.width = W; canvas.height = H;
        buildGalaxy();
    }

    function init(data) {
        traceData = data;
        sortedTrace = [...data].sort((a, b) => a.ts - b.ts);
        TIDS = [...new Set(data.map(e => e.tid))].sort((a, b) => a - b);
        TS_MIN = data.reduce((m, e) => e.ts < m ? e.ts : m, data[0].ts);
        const TS_MAX = data.reduce((m, e) => e.ts > m ? e.ts : m, data[0].ts);
        TS_SPAN = TS_MAX - TS_MIN || 1;
        initialized = true;
    }

    function start() {
        if (!initialized) return;
        canvas = document.getElementById('galaxy3d-canvas');
        if (!canvas) return;
        ctx = canvas.getContext('2d');
        playing = true; running = true; playPos = 0; frame = 0;
        stars = []; nebulae = []; bgStars = [];
        // Defer one frame so flexbox layout is complete before reading clientWidth/Height
        requestAnimationFrame(() => { if (running) buildGalaxy(); });

        // Wire controls
        const playBtn = document.getElementById('gx-play-btn');
        if (playBtn) playBtn.onclick = () => { playing = !playing; playBtn.textContent = playing ? '⏸ PAUSE' : '▶ PLAY'; };

        const explodeBtn = document.getElementById('gx-explode-btn');
        if (explodeBtn) explodeBtn.onclick = () => {
            stars.filter(s => s.dead).forEach(s => {
                for (let i = 0; i < 30; i++) {
                    const ang = Math.random() * Math.PI * 2;
                    s.particles.push({ x: s.sx, y: s.sy, vx: Math.cos(ang) * 6, vy: Math.sin(ang) * 6, life: 1.5, col: GALAXY_COL.DEADLOCK_DETECTED });
                }
            });
        };

        const spreadBtn = document.getElementById('gx-spread-btn');
        if (spreadBtn) spreadBtn.onclick = () => {
            stars.forEach(s => { s.angle = Math.random() * Math.PI * 2; s.orbitR = 80 + Math.random() * Math.min(W / 2, H / 2) * 0.85; s.phase = Math.random() * Math.PI * 2; });
        };

        const clusterBtn = document.getElementById('gx-cluster-btn');
        if (clusterBtn) clusterBtn.onclick = () => { stars.forEach(s => { s.orbitR = 20 + Math.random() * 60; }); };

        // Tooltip
        canvas.onmousemove = e => {
            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left, my = e.clientY - rect.top;
            const hit = stars.find(s => Math.hypot(s.sx - mx, s.sy - my) < s.size + 10);
            const ttp = document.getElementById('gx-tooltip');
            if (hit && ttp) {
                document.getElementById('gx-tt-name').textContent = 'Thread T' + hit.tid;
                document.getElementById('gx-tt-sc').textContent = hit.scenario.replace(/_/g, '-');
                document.getElementById('gx-tt-ev').textContent = hit.count.toLocaleString();
                document.getElementById('gx-tt-lw').textContent = hit.waits.toLocaleString();
                document.getElementById('gx-tt-st').textContent = hit.dead ? '⚠ DEADLOCK' : 'ACTIVE';
                ttp.style.left = (e.clientX + 14) + 'px'; ttp.style.top = (e.clientY - 10) + 'px'; ttp.style.display = 'block';
            } else if (ttp) ttp.style.display = 'none';
        };
        canvas.onmouseleave = () => { const t = document.getElementById('gx-tooltip'); if (t) t.style.display = 'none'; };

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
