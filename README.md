# Chrono-Matrix
### 2D Visual Analytics for Multithreaded Execution

Chrono-Matrix turns real thread execution into an interactive dashboard for reading:

- temporal behavior
- spatial memory activity
- lock contention
- deadlocks
- per-thread performance cost

The core idea is simple:

1. instrument a C++ target with the tracer hooks
2. run it with the LD_PRELOAD hijacker
3. load the emitted JSON trace into the dashboard

The existing 3D visualizations are still part of the project and remain available as
alternative exploration views. The new 2D work adds a clearer temporal + spatial story
without removing the teammate-built 3D pages.

---

## Project Layout

```text
Chrono-Matrix/
├── index.html
├── css/
│   └── style.css
├── js/
│   ├── eventbus.js
│   ├── gantt.js
│   ├── heatmap.js
│   ├── atlas.js
│   ├── chord.js
│   ├── stats.js
│   ├── overview.js
│   ├── profiler.js
│   ├── lockstats.js
│   ├── dependency.js
│   ├── timeline3d.js
│   ├── galaxy3d.js
│   └── flow3d.js
├── scripts/
│   ├── generate_sample_trace.mjs
│   └── generate_many_thread_trace.mjs
├── datasets/
│   ├── many-thread-trace.json
│   └── many-thread-trace.js
├── sample-trace.json
├── sample-trace.js
└── tracer/
    ├── cm_annotate.h
    ├── cm_hijacker.cpp
    ├── producer_consumer.cpp
    ├── uneven_work_distribution.cpp
    ├── master_multithread.cpp
    ├── deadlock.cpp
    ├── wound_wait.cpp
    └── lock_free_counter.cpp
```

---

## What The Tracer Does

The tracer is an `LD_PRELOAD` shared library that intercepts common thread and blocking APIs:

- `pthread_mutex_lock`
- `pthread_mutex_unlock`
- `pthread_create`
- `pthread_join`
- `pthread_cond_wait`
- `pthread_cond_timedwait`
- `read`, `write`, `recv`, `send`
- sleep calls such as `nanosleep`, `clock_nanosleep`, `usleep`

It also exposes source-level hooks so your code can annotate important work directly:

- `CM_COMPUTE("scenario")`
- `CM_MEM_ACCESS(addr, size, kind, scenario)`
- `CM_DEADLOCK_DETECTED(resource, scenario)` when a timed lock attempt times out

The tracer writes one JSON trace per process, named:

- `<program-name>.json`

The file is written in the current working directory of the launched program.

---

## How To Use The Tracer

### 1. Build the hijacker

From the project root:

```bash
g++ -std=c++17 -O2 -fPIC -shared tracer/cm_hijacker.cpp -o tracer/libcmhijack.so -ldl -pthread
```

This creates the shared library used with `LD_PRELOAD`.

### 2. Instrument your C++ target

Include the hook header:

```cpp
#include "cm_annotate.h"
```

Use the macros around important work:

```cpp
CM_COMPUTE("worker_step");
CM_MEM_ACCESS(ptr, sizeof(*ptr), "MEM_READ", "load_row");
CM_MEM_ACCESS(ptr, sizeof(*ptr), "MEM_WRITE", "publish_result");
```

Recommended event kinds:

- `MEM_READ`
- `MEM_WRITE`
- `MEM_ALLOC`
- `MEM_FREE`

### 3. Compile the target with `-ldl`

Any source file that uses `cm_annotate.h` should link with `-ldl`:

```bash
g++ -std=c++17 -O2 -pthread tracer/producer_consumer.cpp -o tracer/producer_consumer -ldl
```

### 4. Run the target under the tracer

Run the binary with `LD_PRELOAD` pointing to the hijacker:

```bash
LD_PRELOAD=./tracer/libcmhijack.so ./tracer/deadlock
```

When the program exits, the tracer writes a file like:

```text
deadlock.json
```

### 5. Load the trace into the dashboard

Open the dashboard from a static server:

```bash
python3 -m http.server 8787
```

Then visit:

```text
http://localhost:8787
```

Use one of these:

- `Load Sample Trace`
- drag and drop your JSON trace
- use the top-bar file upload

---

## Bundled Sample Data

The repo includes ready-to-load sample traces:

- `sample-trace.json`
- `sample-trace.js`
- `datasets/many-thread-trace.json`
- `datasets/many-thread-trace.js`

Regenerate them with:

```bash
node scripts/generate_sample_trace.mjs
node scripts/generate_many_thread_trace.mjs
```

You can also build and run any of the standard demos in `tracer/` directly:

```bash
g++ -std=c++17 -O2 -pthread tracer/deadlock.cpp -o tracer/deadlock -ldl
LD_PRELOAD=./tracer/libcmhijack.so ./tracer/deadlock
```

For a single end-to-end trace that exercises almost every part of the dashboard,
use the master workload:

```bash
g++ -std=c++17 -O2 -pthread tracer/master_multithread.cpp -o tracer/master_multithread -ldl
LD_PRELOAD=./tracer/libcmhijack.so ./tracer/master_multithread
```

---

## Dashboard Views

| View | Purpose |
|---|---|
| Overview | System summary and event distribution |
| Thread Timeline | Time-based execution lanes with zoom and pan |
| Memory Analysis | Address contention heatmap and hottest addresses |
| Trace Atlas | Side-by-side temporal and spatial view |
| Lock Contention | Mutex pressure and dependency structure |
| Thread Profiler | Per-thread compute vs wait breakdown |
| Dependency Graph | Wait-for relationships over time |
| 3D Views | Existing teammate-built exploratory views kept functional |

The new `Trace Atlas` is the best view for reading temporal and spatial behavior together:

- left panel: thread activity over time
- right panel: address activity over time
- clicking a lane or cell selects the same thread everywhere

The 3D views remain available for exploration:

- `Spatial Timeline`
- `Thread Galaxy`
- `Flow Field`

They are still wired through the main dashboard router and can be used alongside the 2D views.

---

## Event Schema

Every trace event is a JSON object with this shape:

```json
{
  "ts": 1234567,
  "tid": 2,
  "event": "LOCK_WAIT",
  "resource": "q_mutex",
  "addr": "0xAA001040",
  "size": 64,
  "duration_us": 450,
  "scenario": "producer_consumer"
}
```

### Field Notes

- `ts`: timestamp in microseconds
- `tid`: logical thread id
- `event`: event kind
- `resource`: mutex, condition variable, or logical resource name
- `addr`: address as a hex string
- `size`: bytes touched for memory events, `0` otherwise
- `duration_us`: event duration in microseconds
- `scenario`: logical scenario name

Supported event kinds:

- `COMPUTE`
- `LOCK_ACQUIRE`
- `LOCK_WAIT`
- `LOCK_RELEASE`
- `THREAD_START`
- `THREAD_END`
- `THREAD_JOIN`
- `COND_WAIT`
- `IO_WAIT`
- `SLEEP`
- `DEADLOCK_DETECTED`
- `MEM_READ`
- `MEM_WRITE`
- `MEM_ALLOC`
- `MEM_FREE`

---

## Included Example Programs

### `tracer/producer_consumer.cpp`

Standard producer-consumer demo with a bounded buffer, producer threads, consumer threads, and memory annotations.

### `tracer/uneven_work_distribution.cpp`

Uneven workload demo where threads finish at different times so the dashboard shows load imbalance clearly.

### `tracer/deadlock.cpp`

Classic AB / BA deadlock demo that emits `DEADLOCK_DETECTED` when the second timed lock attempt times out.

### `tracer/wound_wait.cpp`

Wound-wait prevention demo where the older thread can force the younger thread to back off instead of deadlocking.

### `tracer/lock_free_counter.cpp`

Lock-free counter demo showing how atomic operations can remove the need for mutual exclusion.

---

## What To Expect In The UI

- `DEADLOCK_DETECTED` appears as a deadlock warning and updates the deadlock badge.
- `LOCK_WAIT` shows blocking duration.
- `MEM_READ` and `MEM_WRITE` appear in the timeline, heatmap, and atlas.
- The heatmap shows spatial hotspots by address bucket and time bucket.
- The atlas combines time and space in one readable layout.

---

## Requirements

- `g++` with C++17
- `pthread`
- `ldl` for targets using `cm_annotate.h`
- Python 3 for the static file server
- A modern browser

---

## Notes

- The dashboard accepts both bundled sample traces and traces emitted by your own target.
- If you use `CM_MEM_ACCESS`, make sure the addresses you pass are stable and meaningful for the thing you want to visualize.
- If your target is a black box, you can still feed the dashboard with a JSON trace generated by another tool as long as it matches the schema above.
