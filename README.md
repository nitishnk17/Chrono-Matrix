# ⚡ Chrono-Matrix
### 2D Visual Analytics System for OS/HPC Thread Contention

> A "Cinematic MRI" for parallel software — real C++ execution traces visualized as an interactive 2D analytics dashboard.

---

## 🧩 What It Does

Chrono-Matrix fetches **real multi-threaded execution data** by compiling and running a C++ tracer program, then visualizes that data in a coordinated 2D web dashboard. It helps diagnose:

- **Lock Contention** — which threads block each other and for how long
- **Deadlocks** — threads waiting forever on mutexes in circular dependency
- **False Sharing** — adjacent memory cache-line thrashing under high thread count

---

## 🗂️ Project Structure

```
ThreadVis/
├── index.html              ← Main dashboard entry point
├── README.md
│
├── css/
│   └── style.css           ← Sci-fi dark glassmorphism UI theme
│
├── js/
│   ├── eventbus.js         ← Pub/sub cross-view event coordination
│   ├── gantt.js            ← Thread Timeline chart (zoom/pan + brush)
│   ├── heatmap.js          ← Memory address contention heatmap
│   ├── chord.js            ← Lock contention chord diagram
│   ├── stats.js            ← Per-thread event summary panel
│   └── main.js             ← Orchestrator (loads data, wires views)
│
└── tracer/
    ├── tracer.cpp          ← C++ multi-threaded trace generator (source)
    ├── tracer              ← Compiled binary (generated)
    └── trace.json          ← 48,902-event execution trace (generated)
```

---

## 🚀 Quick Start

The repository already includes a bundled sample dataset in [sample-trace.json](/Users/nitishkumar/Downloads/IIT Delhi/InformationVis/Project copy/TODO/sample-trace.json) and [sample-trace.js](/Users/nitishkumar/Downloads/IIT Delhi/InformationVis/Project copy/TODO/sample-trace.js), so you can open the app and click `Load Sample Trace` without compiling the tracer first.

### Step 1 — Build & Run the C++ Tracer

```bash
cd tracer

# Compile
g++ -std=c++17 -O2 -pthread tracer.cpp -o tracer

# Generate the trace data
./tracer > trace.json
```

Expected output on stderr:
```
[tracer] Running Scenario 1: Producer-Consumer (8 threads)...
[tracer] Running Scenario 2: Deadlock Detection (2 threads)...
[tracer] Running Scenario 3: False Sharing (8 threads)...
[tracer] Done. Total events: 48902
```

### Step 2 — Serve the Dashboard

```bash
# From the ThreadVis/ root directory
cd ..
python3 -m http.server 8787
```

### Step 3 — Open in Browser

```
http://localhost:8787
```

---

## 📊 Dashboard Panels

| Panel | Description |
|---|---|
| **Thread Timeline (Gantt)** | All threads × time. Color-coded by event type. Scroll to zoom, drag to pan, double-click to reset. |
| **Overview Strip (Brush)** | Mini-timeline below the Gantt. Drag to select a time window — all other views filter to it. |
| **Memory Contention Heatmap** | 60×24 time × memory-address grid. Heat intensity = number of lock-wait events. |
| **Lock Contention Chord** | Thread nodes connected by chords proportional to shared lock-wait time. |
| **Thread Event Analysis** | Aggregate stats + per-thread compute vs. wait stacked bars, sorted by worst waiter. |

### Event Color Legend

| Color | Event |
|---|---|
| 🟢 Green `#39ff14` | `COMPUTE` |
| 🟡 Amber `#ffb300` | `LOCK_ACQUIRE` |
| 🔴 Red `#ff3366` | `LOCK_WAIT` / blocking |
| 🔵 Cyan `#00f5ff` | `LOCK_RELEASE` |
| 🟣 Purple `#c84bff` | `DEADLOCK_DETECTED` |

---

## 🔬 Simulated Scenarios

### 1. Producer-Consumer *(Threads T-0 to T-7)*
4 producers and 4 consumers share a mutex-protected bounded queue. Traces show lock contention spikes when the queue is full (producers block) or empty (consumers block).

### 2. Deadlock *(Threads T-10, T-11)*
Two threads attempt to acquire two mutexes in opposite order (classic AB / BA deadlock). A `std::timed_mutex::try_lock_for()` detects the deadlock after an 80ms timeout and emits a `DEADLOCK_DETECTED` event. **T-11 shows the highest wait time (~80ms).**

### 3. False Sharing *(Threads T-20 to T-27)*
8 threads write to adjacent fields of a `alignas(64)` struct — all within the same CPU cache line. This causes heavy cache coherence traffic modeled as high-frequency lock contention visible in the heatmap.

---

## 🕹️ Interactive Features

| Interaction | Effect |
|---|---|
| **Scroll** on Gantt | Zoom in/out on the time axis |
| **Drag** on Gantt background | Pan left/right |
| **Double-click** on Gantt | Reset zoom to full view |
| **Drag** on Overview strip | Select time range → filters Heatmap, Chord, Stats |
| **Click** on a Gantt bar | Select thread → highlights in Chord diagram |
| **Click** on Chord arc | Select thread → cross-highlight |
| **Scenario Pills** | Filter all 4 views to one scenario at a time |
| **↺ Reset All Filters** | Clears scenario, time-range, and thread selection |

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Data Generation | C++17, `std::thread`, `std::mutex`, `std::timed_mutex` |
| Visualization | D3.js v7 (CDN) |
| Frontend | Vanilla HTML / CSS / JavaScript (no framework) |
| Fonts | Google Fonts — Orbitron, Inter, JetBrains Mono |
| Coordination | Custom pub/sub EventBus (`js/eventbus.js`) |

---

## 📦 Requirements

- **C++ compiler**: `g++` with C++17 and pthreads (`-pthread`)
- **Python 3**: for `http.server` (or any static file server)
- **Browser**: Any modern browser (Chrome/Firefox recommended)
- **Internet**: D3.js loaded from CDN (`cdn.jsdelivr.net`)

---

## 📖 Trace JSON Format

Each event in `trace.json` has the following schema:

```json
{
  "ts":          1234567,           // microsecond timestamp (relative to trace start)
  "tid":         2,                 // logical thread ID
  "event":       "LOCK_WAIT",       // COMPUTE | LOCK_ACQUIRE | LOCK_WAIT | LOCK_RELEASE | DEADLOCK_DETECTED
  "resource":    "q_mutex",         // mutex or condition variable name
  "addr":        "0xAA001040",      // simulated memory address (cache-line bucket)
  "duration_us": 450,               // how long this event lasted (microseconds)
  "scenario":    "producer_consumer" // producer_consumer | deadlock | false_sharing
}
```

---

## 🎓 Academic Context

**Course:** Information Visualization — Semester 2  
**Topic:** Diagnosing Parallel Execution Bottlenecks through 2D Visual Analytics  
**Technique:** Coordinated Multiple Views (CMV) — linking a temporal scrubber to a spatial memory contention renderer

### Key Insights Visualized
- A **purple bar on T-11** in the Gantt = the deadlock wait event (80ms blocked)
- A **hot red band at `0xCC003000`** in the heatmap = false-sharing cache-line thrashing
- **Thick chords between T-0/T-4** in the chord diagram = producer-consumer mutex contention
