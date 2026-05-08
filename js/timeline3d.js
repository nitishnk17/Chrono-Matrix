/**
 * timeline3d.js — 3D Topographic Ridgeline (Area Chart)
 * Thread activity visualized as continuous rolling 3D mountain ridges.
 * This is designed to be instantly readable: X = Time, Z = Thread, Y = Activity.
 */

var Timeline3D = (() => {

    // ── Geometry settings ──────────────────────────────────────
    const COLS    = 60;      // time bins along X axis
    const W_STEP  = 18;      // width per time bin
    const D_STEP  = 40;      // depth per thread
    const MAX_H   = 180;     // max height of a peak
    const FLOAT_Y = 10;      // bobbing y offset

    // ── State ─────────────────────────────────────────────────
    let canvas, ctx, tooltip;
    let allData = [], threads = [], events = [];
    let initialized = false;
    let animId = null;
    let playing = false;
    let frameCount = 0;
    let controlsBound = false;

    // Camera
    let rotX = 0.5, rotY = 0.35, zoom = 0.95;
    let drag = false, lastMX = 0, lastMY = 0;
    let camTarget = null;
    const CAM_TWEEN = 0.08;
    let autoRotate = false;

    // Grid data (pre-computed)
    let ROWS = 8;
    let gridH   = [];    // [row][col] 0..1 normalised height
    let gridCol = [];    // [row][col] dominant event hex colour
    let gridEv  = [];    // [row][col] dominant event name
    let floatBase = [];  // [row][col] sine wave phase

    // Scan beam
    let scanPos = 0;

    // Filter
    let activeFilter = 'all';

    // Layout
    let W, H, cx, cy;

    // ── 3-D → 2-D projection ─────────────────────────────────
    function project(wx, wy, wz) {
        const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
        const rx  =  wx * cosY + wz * sinY;
        const rz  = -wx * sinY + wz * cosY;
        
        const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
        const ry  =  wy * cosX - rz * sinX;
        const rz2 =  wy * sinX + rz * cosX;
        
        const fov  = 860 * zoom;
        const dist = fov + rz2 * 0.45;
        if (dist < 1) return { x: cx, y: cy, z: rz2 };
        const sc = fov / dist;
        return { x: cx + rx * sc, y: cy - ry * sc, z: rz2 };
    }

    // ── Colour helpers ────────────────────────────────────────
    const COL = () => EventBus.colors;

    function hexToRgb(hex) {
        const hc = hex.replace('#', '');
        return [parseInt(hc.slice(0,2),16), parseInt(hc.slice(2,4),16), parseInt(hc.slice(4,6),16)];
    }
    function hexToRgba(hex, a) {
        const [r,g,b] = hexToRgb(hex);
        return `rgba(${r},${g},${b},${a})`;
    }

    // Smooth blending for heights and colors
    function lerp(a, b, t) { return a + (b-a)*t; }
    function mixColor(hex1, hex2, pct) {
        const [r1,g1,b1] = hexToRgb(hex1);
        const [r2,g2,b2] = hexToRgb(hex2);
        const r = r1 + (r2-r1)*pct | 0;
        const g = g1 + (g2-g1)*pct | 0;
        const b = b1 + (b2-b1)*pct | 0;
        return `rgb(${r},${g},${b})`;
    }

    // ── Build data grid ───────────────────────────────────────
    function buildGrid() {
        ROWS = Math.min(Math.max(threads.length, 1), 32);
        if (ROWS < 1) return;
        
        gridH   = Array.from({length:ROWS}, ()=>new Float32Array(COLS));
        gridCol = Array.from({length:ROWS}, ()=>Array(COLS).fill('#1e293b'));
        gridEv  = Array.from({length:ROWS}, ()=>Array(COLS).fill(''));
        floatBase = Array.from({length:ROWS}, ()=>Array.from({length:COLS}, ()=>Math.random()*Math.PI*2));

        const vis = events.filter(e => activeFilter==='all' || e.event===activeFilter);
        if (!vis.length) return;

        const minTs = Math.min(...vis.map(e=>e.ts-e.duration_us));
        const maxTs = Math.max(...vis.map(e=>e.ts));
        const span  = maxTs - minTs || 1;

        const bins = Array.from({length:ROWS}, ()=>Array.from({length:COLS},()=>({total:0,ev:{}})));

        vis.forEach(e => {
            const ti = threads.indexOf(e.tid);
            if (ti<0||ti>=ROWS) return;
            const c = Math.min(COLS-1, Math.max(0, Math.floor(((e.ts-minTs)/span)*(COLS-1))));
            bins[ti][c].total += e.duration_us;
            bins[ti][c].ev[e.event] = (bins[ti][c].ev[e.event]||0) + e.duration_us;
        });

        let maxBin = 0;
        bins.forEach(row=>row.forEach(b=>{ if(b.total>maxBin) maxBin=b.total; }));
        if (maxBin===0) return;

        // Smooth pass to make mountains look more natural and continuous
        const rawH = Array.from({length:ROWS}, ()=>new Float32Array(COLS));

        bins.forEach((row,r)=>row.forEach((b,c)=>{
            rawH[r][c] = Math.sqrt(b.total/maxBin);
            const dom = Object.entries(b.ev).sort((a,b)=>b[1]-a[1])[0];
            if (dom){ gridEv[r][c]=dom[0]; gridCol[r][c]=COL()[dom[0]]||'#38bdf8'; }
        }));

        // Apply 3-tap smoothing to height (makes beautiful continuous ridges)
        for(let r=0; r<ROWS; r++) {
            for(let c=0; c<COLS; c++) {
                let sum = rawH[r][c], count = 1;
                if(c > 0) { sum+=rawH[r][c-1]*0.6; count+=0.6; }
                if(c < COLS-1) { sum+=rawH[r][c+1]*0.6; count+=0.6; }
                
                // Inherit color if surrounding has color but current is empty
                if (rawH[r][c] === 0) {
                    if (c > 0 && rawH[r][c-1] > 0) gridCol[r][c] = gridCol[r][c-1];
                    else if (c < COLS-1 && rawH[r][c+1] > 0) gridCol[r][c] = gridCol[r][c+1];
                }

                gridH[r][c] = sum/count;
            }
        }
    }

    // ── Background & Grid Base ────────────────────────────────
    let bgParticles = [];
    function initBg() {
        bgParticles = Array.from({length: 120}, ()=>({
            x: Math.random(), y: Math.random(),
            s: 0.5+Math.random()*2, a: 0.1+Math.random()*0.5,
            vx: (Math.random()-0.5)*0.001, vy: -0.0005-Math.random()*0.001
        }));
    }

    function drawBackground() {
        // Aesthetic linear gradient representing digital dusk
        const grad = ctx.createLinearGradient(0,0, 0,H);
        grad.addColorStop(0, '#02000d');
        grad.addColorStop(0.4, '#05041a');
        grad.addColorStop(1, '#0a0d26');
        ctx.fillStyle = grad;
        ctx.fillRect(0,0,W,H);

        // Grid floor
        const totalW = (COLS-1) * W_STEP;
        const totalD = (ROWS-1) * D_STEP;

        ctx.globalAlpha = 0.15;
        ctx.beginPath();
        for(let c=0; c<=COLS; c+=2) {
            const xVal = -totalW/2 + c*W_STEP;
            const p1 = project(xVal, -FLOAT_Y, -totalD/2 - 20);
            const p2 = project(xVal, -FLOAT_Y, totalD/2 + 20);
            ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
        }
        for(let r=0; r<=ROWS; r++) {
            const zVal = -totalD/2 + r*D_STEP;
            const p1 = project(-totalW/2 - 20, -FLOAT_Y, zVal);
            const p2 = project(totalW/2 + 20, -FLOAT_Y, zVal);
            ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
        }
        ctx.strokeStyle = '#0ea5e9';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalAlpha = 1;

        // Background rising particles
        ctx.fillStyle = '#fff';
        bgParticles.forEach(p => {
            p.x += p.vx; p.y += p.vy;
            if(p.y < 0) { p.y=1; p.x=Math.random(); }
            ctx.globalAlpha = p.a;
            ctx.beginPath(); ctx.arc(p.x*W, p.y*H, p.s, 0, Math.PI*2); ctx.fill();
        });
        ctx.globalAlpha=1;
    }

    // ── Render Topographic Ridgelines ─────────────────────────
    function renderRidges() {
        if (!ROWS||!gridH.length) return;

        const totalW = (COLS-1) * W_STEP;
        const totalD = (ROWS-1) * D_STEP;

        // Render back-to-front (largest Z first)
        // Since isometric typically points "into" the screen, 
        // smaller Z is front, larger Z is back. We compute center Z for accurate sorting.

        let threadsObj = [];
        for (let r=0; r<ROWS; r++) {
            const zBase = -totalD/2 + r*D_STEP + (FLOAT_Y * 0.5 * Math.sin(frameCount*0.02 + r));
            const pCenter = project(0, 0, zBase);
            threadsObj.push({r, zBase, projectedZ: pCenter.z });
        }
        threadsObj.sort((a,b) => b.projectedZ - a.projectedZ);

        threadsObj.forEach(th => {
            const r = th.r;
            const z = th.zBase;
            const points = [];

            // Calculate world coords for this ridge
            for (let c=0; c<COLS; c++) {
                const x = -totalW/2 + c * W_STEP;
                const bob = FLOAT_Y * 0.3 * Math.sin(frameCount*0.03 + floatBase[r][c]);
                const y = gridH[r][c] * MAX_H + bob;
                points.push({ wx: x, wy: y, wz: z, col: gridCol[r][c], ev: gridEv[r][c], h: gridH[r][c] });
            }

            // Draw Area Fill
            ctx.beginPath();
            const startFloor = project(points[0].wx, -FLOAT_Y, z);
            ctx.moveTo(startFloor.x, startFloor.y);

            let projPoints = [];
            for (let c=0; c<COLS; c++) {
                const pj = project(points[c].wx, points[c].wy, points[c].wz);
                projPoints.push(pj);
                if (c===0) ctx.lineTo(pj.x, pj.y);
                else {
                    // Smooth curve between points
                    const prevPj = projPoints[c-1];
                    const cx1 = prevPj.x + (pj.x - prevPj.x) * 0.5;
                    const cx2 = prevPj.x + (pj.x - prevPj.x) * 0.5;
                    ctx.bezierCurveTo(cx1, prevPj.y, cx2, pj.y, pj.x, pj.y);
                }
            }

            const endFloor = project(points[COLS-1].wx, -FLOAT_Y, z);
            ctx.lineTo(endFloor.x, endFloor.y);
            ctx.closePath();

            // Gradient from solid black-blue at base to transparent at top
            // Using bounding box of projected polygon
            const minY = Math.min(...projPoints.map(p=>p.y));
            const maxY = Math.max(startFloor.y, endFloor.y);
            
            const areaGrad = ctx.createLinearGradient(0, minY, 0, maxY);
            areaGrad.addColorStop(0, 'rgba(8, 14, 30, 0.95)');
            areaGrad.addColorStop(1, 'rgba(4, 6, 16, 0.98)');
            ctx.fillStyle = areaGrad;
            ctx.fill();

            // Outline for area
            ctx.strokeStyle = 'rgba(0, 200, 255, 0.15)';
            ctx.lineWidth = 1;
            ctx.stroke();

            // Draw Top glowing line (multi-colored based on events)
            ctx.lineWidth = 3;
            for (let c=0; c<COLS-1; c++) {
                const p1 = projPoints[c];
                const p2 = projPoints[c+1];
                const col = points[c].h > 0.05 ? points[c].col : 'rgba(100,116,139,0.3)';
                
                ctx.beginPath();
                ctx.moveTo(p1.x, p1.y);
                const cx1 = p1.x + (p2.x - p1.x) * 0.5;
                const cx2 = p1.x + (p2.x - p1.x) * 0.5;
                ctx.bezierCurveTo(cx1, p1.y, cx2, p2.y, p2.x, p2.y);

                if (points[c].h > 0.05) {
                    ctx.shadowColor = col;
                    ctx.shadowBlur = 10;
                    ctx.strokeStyle = col;
                } else {
                    ctx.shadowBlur = 0;
                    ctx.strokeStyle = col;
                }
                ctx.stroke();

                // Draw deadlock warning pulse
                if (points[c].ev === 'DEADLOCK_DETECTED') {
                    ctx.save();
                    ctx.shadowColor = EventBus.colors.DEADLOCK_DETECTED;
                    ctx.shadowBlur = 20;
                    ctx.fillStyle = '#fff';
                    ctx.beginPath();
                    const rSize = 3 + 2*Math.sin(frameCount*0.15);
                    ctx.arc(p1.x, p1.y, rSize, 0, Math.PI*2);
                    ctx.fill();
                    ctx.restore();
                }
            }
            ctx.shadowBlur = 0;
        });
    }

    // ── Axis Labels ───────────────────────────────────────────
    function drawAxisLabels() {
        const totalW = (COLS-1) * W_STEP;
        const totalD = (ROWS-1) * D_STEP;
        
        ctx.font='700 10px Inter, Orbitron, sans-serif'; 
        ctx.textAlign='center';
        
        // Time Axis
        const tStart = project(-totalW/2, -FLOAT_Y-20, totalD/2 + 30);
        const tEnd = project(totalW/2, -FLOAT_Y-20, totalD/2 + 30);
        
        ctx.fillStyle = '#0ea5e9';
        ctx.fillText('TIME START', tStart.x, tStart.y);
        ctx.fillText('TIME END', tEnd.x, tEnd.y);
        
        ctx.beginPath();
        ctx.moveTo(tStart.x + 30, tStart.y - 4);
        ctx.lineTo(tEnd.x - 30, tEnd.y - 4);
        ctx.strokeStyle = 'rgba(14, 165, 233, 0.4)';
        ctx.lineWidth = 1;
        ctx.stroke();
        
        // Threads notation on left side
        ctx.textAlign='right';
        for (let r=0; r<ROWS; r+=Math.ceil(ROWS/8)) {
            const tid = threads[r] || r;
            const pt = project(-totalW/2 - 30, -FLOAT_Y, -totalD/2 + r*D_STEP);
            ctx.fillStyle = 'rgba(255,255,255,0.5)';
            ctx.fillText(`T-${tid}`, pt.x, pt.y + 4);
        }
        ctx.textAlign='left';
    }

    // ── Scan beam ─────────────────────────────────────────────
    function drawScanBeam() {
        if (!gridH.length) return;
        const totalW = (COLS-1) * W_STEP;
        const totalD = (ROWS-1) * D_STEP;
        const xPos = -totalW/2 + scanPos * totalW;

        const b1 = project(xPos, -FLOAT_Y-10, -totalD/2-20);
        const b2 = project(xPos, -FLOAT_Y-10, totalD/2+20);
        const t2 = project(xPos, MAX_H + 30, totalD/2+20);
        const t1 = project(xPos, MAX_H + 30, -totalD/2-20);

        ctx.beginPath();
        ctx.moveTo(b1.x, b1.y); ctx.lineTo(b2.x, b2.y);
        ctx.lineTo(t2.x, t2.y); ctx.lineTo(t1.x, t1.y);
        ctx.closePath();
        
        const grad = ctx.createLinearGradient(b1.x, b1.y, t1.x, t1.y);
        grad.addColorStop(0, 'rgba(0, 229, 255, 0.15)');
        grad.addColorStop(1, 'transparent');
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(b1.x, b1.y); ctx.lineTo(b2.x, b2.y);
        ctx.strokeStyle = 'rgba(0, 229, 255, 0.8)';
        ctx.lineWidth = 2;
        ctx.stroke();
        
        // Glitch node on the beam
        ctx.fillStyle = '#fff';
        const pulse = project(xPos, -FLOAT_Y-10, 0);
        ctx.fillRect(pulse.x-2, pulse.y-1, 4, 3);
    }

    // ── UI Overlay ────────────────────────────────────────────
    let legendBuilt=false;
    function populateLegend(){
        if(legendBuilt) return;
        const el=document.getElementById('tl3-legend');
        if(!el||!events.length) return;
        const evTypes=[...new Set(events.map(e=>e.event))].sort();
        el.innerHTML=evTypes.map(ev=>{
            const col=COL()[ev]||'#64748b';
            return `<div class="viz3d-legend-item">
                <span class="viz3d-dot" style="background:${col};box-shadow:0 0 5px ${col}"></span>
                <span style="font-size:0.65rem; font-family: Inter, sans-serif;">${ev.replace(/_/g,' ')}</span></div>`;
        }).join('');
        legendBuilt=true;
    }

    function updateHUD(){
        if(frameCount%60!==0) return;
        const vis=events.filter(e=>activeFilter==='all'||e.event===activeFilter);
        const el=id=>document.getElementById(id);
        if(el('tl3-hud-threads')) el('tl3-hud-threads').textContent=threads.length;
        if(el('tl3-hud-events'))  el('tl3-hud-events').textContent=vis.length.toLocaleString();
        const mx=vis.reduce((m,e)=>e.duration_us>m?e.duration_us:m,0);
        if(el('tl3-hud-dur')) el('tl3-hud-dur').textContent=fmtUs(mx);
    }
    function fmtUs(v){
        if(v>=1e6) return (v/1e6).toFixed(1)+'s';
        if(v>=1e3) return (v/1e3).toFixed(0)+'ms';
        return v.toFixed(0)+'µs';
    }

    // ── Main Render Loop ──────────────────────────────────────
    function render() {
        if(!canvas||!ctx) return;
        W=canvas.width; H=canvas.height;
        cx=W*0.5; cy=H*0.55; 
        frameCount++;

        if(camTarget){
            rotX += (camTarget.rotX - rotX) * CAM_TWEEN;
            rotY += (camTarget.rotY - rotY) * CAM_TWEEN;
            zoom += (camTarget.zoom - zoom) * CAM_TWEEN;
            if(Math.abs(camTarget.rotX-rotX)<0.001 && Math.abs(camTarget.rotY-rotY)<0.001) camTarget=null;
        }
        if(autoRotate && !drag) rotY += 0.002;

        scanPos = (scanPos + 0.0015) % 1;

        drawBackground();

        if(!events.length){
            ctx.fillStyle='#8b949e'; ctx.font='14px Orbitron, monospace';
            ctx.textAlign='center'; ctx.fillText('No events to display',cx,cy);
            return;
        }

        drawAxisLabels();
        renderRidges();
        drawScanBeam();
        populateLegend();
        updateHUD();

        ctx.textAlign='left'; ctx.globalAlpha=0.35;
        ctx.font='500 10px Inter, sans-serif'; ctx.fillStyle='#94a3b8';
        ctx.fillText('drag to orbit  ·  scroll to zoom',12,H-14);
        ctx.globalAlpha=1;
    }

    function loop(){
        if(!playing){ animId=null; return; }
        render();
        animId=requestAnimationFrame(loop);
    }

    // ── Camera Presets ────────────────────────────────────────
    const PRESETS = {
        iso:   { rotX: 0.50, rotY:  0.35, zoom: 0.95 },
        front: { rotX: 0.05, rotY:  0.00, zoom: 1.20 },
        side:  { rotX: 0.20, rotY:  1.57, zoom: 0.85 },
    };
    function tweenTo(p){ if(PRESETS[p]) camTarget={...PRESETS[p]}; }

    // ── Controls & UX ─────────────────────────────────────────
    function bindControls(){
        if (controlsBound || !canvas) return;
        controlsBound = true;

        canvas.addEventListener('mousedown',e=>{
            drag=true; lastMX=e.clientX; lastMY=e.clientY;
            canvas.style.cursor='grabbing'; camTarget=null;
        });
        window.addEventListener('mouseup',()=>{ drag=false; canvas.style.cursor=autoRotate?'default':'grab'; });
        window.addEventListener('mousemove',e=>{
            if(!drag) return;
            rotY += (e.clientX-lastMX) * 0.008;
            rotX = Math.max(-1.5, Math.min(1.5, rotX + (e.clientY-lastMY)*0.005));
            lastMX=e.clientX; lastMY=e.clientY; camTarget=null;
        });
        canvas.addEventListener('wheel',e=>{
            e.preventDefault();
            zoom *= e.deltaY>0 ? 0.93 : 1.07;
            zoom = Math.max(0.3, Math.min(3.5, zoom)); camTarget=null;
        },{passive:false});

        canvas.addEventListener('mousemove',showTooltip);
        canvas.addEventListener('mouseleave',()=>{ if(tooltip) tooltip.style.display='none'; });

        document.getElementById('tl3-reset-cam')?.addEventListener('click',()=>tweenTo('iso'));

        const arBtn=document.getElementById('tl3-autorot');
        if(arBtn) arBtn.addEventListener('click',()=>{
            autoRotate=!autoRotate;
            arBtn.textContent=autoRotate?'↻ AUTO ON':'↻ AUTO OFF';
            arBtn.style.color=autoRotate?'#0ea5e9':'';
            arBtn.style.borderColor=autoRotate?'#0ea5e9':'';
            canvas.style.cursor=autoRotate?'default':'grab';
        });

        ['iso','front','side'].forEach(p=>
            document.getElementById(`tl3-cam-${p}`)?.addEventListener('click',()=>tweenTo(p))
        );

        document.getElementById('tl3-filter')?.addEventListener('change',e=>{
            activeFilter=e.target.value;
            legendBuilt=false;
            buildGrid();
        });
    }

    // ── Tooltip ───────────────────────────────────────────────
    function showTooltip(e){
        if(!tooltip||!gridH.length) return;
        const rect=canvas.getBoundingClientRect();
        const mx=e.clientX-rect.left, my=e.clientY-rect.top;
        
        const totalW = (COLS-1) * W_STEP;
        const totalD = (ROWS-1) * D_STEP;
        
        let best=null, bestD=30;

        for(let r=0;r<ROWS;r++){
            for(let c=0;c<COLS;c++){
                if(gridH[r][c] < 0.05) continue;
                
                const x = -totalW/2 + c * W_STEP;
                const z = -totalD/2 + r * D_STEP;
                const y = gridH[r][c] * MAX_H;
                const proj = project(x, y, z);

                const d=Math.hypot(proj.x-mx,proj.y-my);
                if(d<bestD){ bestD=d; best={r,c}; }
            }
        }

        if(best){
            const {r,c}=best;
            const col=gridCol[r][c], ev=gridEv[r][c], tid=threads[r] || "Sys";
            tooltip.style.display='block';
            EventBus.positionTooltip(tooltip, e, { preferAbove: true });
            tooltip.innerHTML=`
                <div class="viz3d-tt-name" style="font-family:Inter,sans-serif">T-${tid}</div>
                <div class="viz3d-tt-row"><span class="viz3d-tt-k">Event</span>
                    <span class="viz3d-tt-v" style="color:${col}; text-shadow: 0 0 5px ${col}">${ev.replace(/_/g,' ')||'—'}</span></div>
                <div class="viz3d-tt-row"><span class="viz3d-tt-k">Activity Height</span>
                    <span class="viz3d-tt-v">${(gridH[r][c]*100).toFixed(0)}%</span></div>`;
        } else {
            tooltip.style.display='none';
        }
    }

    // ── Public API ────────────────────────────────────────────
    return {
        init(data){
            allData=data;
            threads=[...new Set(data.map(d=>d.tid))].sort((a,b)=>a-b);
            events=data.filter(d=>d.duration_us>0&&!['THREAD_START','THREAD_END'].includes(d.event));
            initialized=true; legendBuilt=false;
            initBg();
        },
        start(){
            if(!initialized) return;
            canvas=document.getElementById('tl3d-canvas');
            tooltip=document.getElementById('tl3d-tooltip');
            if(!canvas) return;
            playing=true;
            rotX=0.5; rotY=0.35; zoom=0.95; camTarget=null;
            autoRotate=false; frameCount=0; scanPos=0;
            legendBuilt=false; gridH=[];

            const arBtn=document.getElementById('tl3-autorot');
            if(arBtn){ arBtn.textContent='↻ AUTO OFF'; arBtn.style.color=''; arBtn.style.borderColor=''; }

            requestAnimationFrame(()=>{
                if(!playing) return;
                const wrap=document.getElementById('tl3d-canvas-wrap');
                if(wrap){ canvas.width=wrap.clientWidth||1200; canvas.height=wrap.clientHeight||520; }
                ctx=canvas.getContext('2d');
                canvas.style.cursor='grab';
                buildGrid();
                bindControls();
                if(!animId) loop();
            });
        },
        stop(){
            playing=false;
            if(animId){ cancelAnimationFrame(animId); animId=null; }
        },
        resize(){
            if(!canvas) return;
            const wrap=document.getElementById('tl3d-canvas-wrap');
            if(wrap){ canvas.width=wrap.clientWidth; canvas.height=wrap.clientHeight; }
        }
    };
})();
