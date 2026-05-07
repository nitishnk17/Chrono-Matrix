/**
 * eventbus.js — Tiny pub/sub event bus for cross-view coordination
 */

// Centralized Design Tokens — cohesive modern palette
const EVENT_COLORS = {
    'COMPUTE':           '#38bdf8',   // sky-blue   — active computation
    'IO_WAIT':           '#fb923c',   // orange     — waiting on I/O
    'SLEEP':             '#64748b',   // slate-grey — idle sleep
    'COND_WAIT':         '#e879f9',   // fuchsia    — condition variable wait
    'LOCK_WAIT':         '#f43f5e',   // rose-red   — blocked on mutex
    'LOCK_ACQUIRE':      '#34d399',   // emerald    — mutex acquired
    'LOCK_RELEASE':      '#94a3b8',   // cool-grey  — mutex released
    'THREAD_JOIN':       '#a78bfa',   // violet     — joining another thread
    'THREAD_START':      '#4ade80',   // green      — thread born
    'THREAD_END':        '#475569',   // dark-slate — thread exits
    'DEADLOCK_DETECTED': '#ef4444',   // red        — deadlock
};

const EventBus = (() => {
    const listeners = {};
    return {
        colors: EVENT_COLORS,
        on(event, cb) {
            if (!listeners[event]) listeners[event] = [];
            listeners[event].push(cb);
        },
        emit(event, data) {
            (listeners[event] || []).forEach(cb => cb(data));
        },
        clear() {
            Object.keys(listeners).forEach(k => delete listeners[k]);
        },
        off(event, cb) {
            if (listeners[event])
                listeners[event] = listeners[event].filter(fn => fn !== cb);
        }
    };
})();
