#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#include <cstdint>
#include <dlfcn.h>
#include <pthread.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <atomic>
#include <string.h>
#include <signal.h>
#include <fcntl.h>

// Function pointers for OS-level sleep functions
typedef int (*nanosleep_t)(const struct timespec *req, struct timespec *rem);
typedef int (*clock_nanosleep_t)(clockid_t clockid, int flags, const struct timespec *request, struct timespec *remain);
typedef int (*usleep_t)(useconds_t usec);

static nanosleep_t real_nanosleep = NULL;
static clock_nanosleep_t real_clock_nanosleep = NULL;
static usleep_t real_usleep = NULL;


// Function pointers to the real OS-level mutex functions
typedef int (*pthread_mutex_lock_t)(pthread_mutex_t *);
typedef int (*pthread_mutex_unlock_t)(pthread_mutex_t *);

typedef int (*pthread_create_t)(pthread_t *, const pthread_attr_t *, void *(*)(void *), void *);
typedef int (*pthread_join_t)(pthread_t, void **);
typedef int (*pthread_cond_wait_t)(pthread_cond_t *, pthread_mutex_t *);
typedef int (*pthread_cond_timedwait_t)(pthread_cond_t *, pthread_mutex_t *, const struct timespec *);

typedef ssize_t (*read_t)(int, void *, size_t);
typedef ssize_t (*write_t)(int, const void *, size_t);
typedef ssize_t (*recv_t)(int, void *, size_t, int);
typedef ssize_t (*send_t)(int, const void *, size_t, int);

static pthread_mutex_lock_t real_lock = NULL;
static pthread_mutex_unlock_t real_unlock = NULL;

static pthread_create_t real_create = NULL;
static pthread_join_t real_join = NULL;
static pthread_cond_wait_t real_cond_wait = NULL;
static pthread_cond_timedwait_t real_cond_timedwait = NULL;

static read_t real_read = NULL;
static write_t real_write = NULL;
static recv_t real_recv = NULL;
static send_t real_send = NULL;

static int initialized = 0;
static uint64_t start_time_us = 0;

// Thread-local flags to prevent recursion and track hold times
__thread int in_tracer = 0;
__thread uint64_t hold_start_time = 0;
__thread int my_tid = 0;

// GLOBAL Lock-Free Ring Buffer
#define BUFFER_SIZE 2000000 // 2 Million Events
struct TraceEvent {
    uint64_t ts;
    int tid;
    const char* event_name;
    void* addr;         // Mutex Address (Resource)
    void* caller_addr;  // Function Address (Scenario)
    uint64_t duration_us;
};

static TraceEvent global_events[BUFFER_SIZE];
static std::atomic<uint64_t> write_head{0};
static std::atomic<uint64_t> read_tail{0};
static int fd_out = -1;
static pthread_t flusher_tid;
static std::atomic<bool> is_shutting_down{false};

static void flush_buffer(bool is_exit = false);
static void* background_flusher(void*);

// The custom Ctrl+C catcher
static void sigint_handler(int signum) {
    if (in_tracer) _exit(signum); // prevent recursion if interrupted while tracing
    in_tracer = 1;
    printf("\n[CM_Hijacker] Caught Signal %d. Flushing remaining trace to disk...\n", signum);
    flush_buffer(true);
    _exit(signum); 
}

uint64_t get_time_us() {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000 + ts.tv_nsec / 1000;
}

static void initialize() {
    // Double-checked locking to avoid dlsym recursion if a hook triggers it
    static std::atomic<int> init_state{0}; 
    int expected = 0;
    
    if (init_state.compare_exchange_strong(expected, 1)) { // Only 1 thread can ever enter this block
        real_lock = (pthread_mutex_lock_t)dlsym(RTLD_NEXT, "pthread_mutex_lock");
        real_unlock = (pthread_mutex_unlock_t)dlsym(RTLD_NEXT, "pthread_mutex_unlock");
        
        real_nanosleep = (nanosleep_t)dlsym(RTLD_NEXT, "nanosleep");
        real_clock_nanosleep = (clock_nanosleep_t)dlsym(RTLD_NEXT, "clock_nanosleep");
        real_usleep = (usleep_t)dlsym(RTLD_NEXT, "usleep");
        
        real_create = (pthread_create_t)dlsym(RTLD_NEXT, "pthread_create");
        real_join = (pthread_join_t)dlsym(RTLD_NEXT, "pthread_join");
        real_cond_wait = (pthread_cond_wait_t)dlsym(RTLD_NEXT, "pthread_cond_wait");
        real_cond_timedwait = (pthread_cond_timedwait_t)dlsym(RTLD_NEXT, "pthread_cond_timedwait");

        real_read = (read_t)dlsym(RTLD_NEXT, "read");
        real_write = (write_t)dlsym(RTLD_NEXT, "write");
        real_recv = (recv_t)dlsym(RTLD_NEXT, "recv");
        real_send = (send_t)dlsym(RTLD_NEXT, "send");

        signal(SIGINT, sigint_handler);
        signal(SIGTERM, sigint_handler);
        signal(SIGSEGV, sigint_handler); // Catch crashes
        
        start_time_us = get_time_us();
        
        // Open Output File
        char filename[256];
        snprintf(filename, sizeof(filename), "hijack_trace_%d.json", getpid());
        fd_out = open(filename, O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (fd_out >= 0) {
            real_write(fd_out, "[\n", 2);
        }

        initialized = 1;
        init_state.store(2); // Fully initialized
        
        // Start Background Disk Flusher
        if (real_create) {
            real_create(&flusher_tid, NULL, background_flusher, NULL);
        }
        
    } else {
        // Yield/Spin until the first thread finishes initialization
        while (init_state.load() != 2) {
            if (real_nanosleep) {
                struct timespec ts = {0, 1000000}; // 1ms
                real_nanosleep(&ts, NULL);
            }
        }
    }
}

// END OF DUPLICATES
struct ThreadWaitState {
    int tid;
    void* waiting_on_mutex;
    uint64_t wait_start_ts;
    void* caller_addr;
};
static ThreadWaitState active_waits[256];

// Format and write an event directly to the open JSON file descriptor
static void write_event_to_disk(const TraceEvent& e, bool is_first) {
    char buf[512];
    
    const char* res_prefix = "Mutex_";
    const char* scen_prefix = "Func_";
    const void* res_val = e.addr;
    const void* scen_val = e.caller_addr;
    
    if (strcmp(e.event_name, "COMPUTE") == 0) {
        res_prefix = ""; res_val = (void*)"CPU";
        scen_prefix = ""; scen_val = e.caller_addr; // Caller addr holds the scenario string
        
        int len = snprintf(buf, sizeof(buf),
            "%s\n  {\n    \"ts\": %lu,\n    \"tid\": %d,\n    \"event\": \"%s\",\n    \"resource\": \"%s\",\n    \"scenario\": \"%s\",\n    \"addr\": \"%p\",\n    \"duration_us\": %lu\n  }",
            is_first ? "" : ",", e.ts, e.tid, e.event_name, (const char*)res_val, (const char*)scen_val, e.addr, e.duration_us);
        if (len > 0) real_write(fd_out, buf, len);
        return;
    } else if (strcmp(e.event_name, "SLEEP") == 0) {
        res_prefix = ""; res_val = (void*)"OS_Scheduler";
        scen_prefix = "Thread_Yield_";
    } else if (strncmp(e.event_name, "THREAD_", 7) == 0) {
        res_prefix = ""; res_val = (void*)"Thread_Lifecycle";
        scen_prefix = "Lifecycle_";
    } else if (strcmp(e.event_name, "COND_WAIT") == 0) {
        res_prefix = "CondVar_";
    } else if (strcmp(e.event_name, "IO_WAIT") == 0) {
        res_prefix = "FD_";
        scen_prefix = "IO_";
    }
    
    int len = 0;
    
    // Explicitly handle string literals vs pointers
    if (strcmp(e.event_name, "COMPUTE") == 0 || strcmp(e.event_name, "SLEEP") == 0 || strncmp(e.event_name, "THREAD_", 7) == 0) {
        len = snprintf(buf, sizeof(buf),
            "%s\n  {\n    \"ts\": %lu,\n    \"tid\": %d,\n    \"event\": \"%s\",\n    \"resource\": \"%s%s\",\n    \"scenario\": \"%s%p\",\n    \"addr\": \"%p\",\n    \"duration_us\": %lu\n  }",
            is_first ? "" : ",", e.ts, e.tid, e.event_name, res_prefix, (const char*)res_val, scen_prefix, scen_val, e.addr, e.duration_us);
    } else {
        len = snprintf(buf, sizeof(buf),
            "%s\n  {\n    \"ts\": %lu,\n    \"tid\": %d,\n    \"event\": \"%s\",\n    \"resource\": \"%s%p\",\n    \"scenario\": \"%s%p\",\n    \"addr\": \"%p\",\n    \"duration_us\": %lu\n  }",
            is_first ? "" : ",", e.ts, e.tid, e.event_name, res_prefix, res_val, scen_prefix, scen_val, e.addr, e.duration_us);
    }
    
    if (len > 0) {
        real_write(fd_out, buf, len);
    }
}

static void flush_buffer(bool is_exit) {
    if (fd_out < 0) return;
    
    uint64_t head = write_head.load(std::memory_order_acquire);
    uint64_t tail = read_tail.load(std::memory_order_relaxed);
    
    if (tail >= head && !is_exit) return; // Nothing to flush
    
    bool is_first = (tail == 0);
    while (tail < head) {
        uint64_t idx = tail % BUFFER_SIZE;
        write_event_to_disk(global_events[idx], is_first && tail == 0);
        tail++;
        is_first = false;
    }
    
    read_tail.store(tail, std::memory_order_release);
    
    if (is_exit) {
        real_write(fd_out, "\n]\n", 3);
        close(fd_out);
        fd_out = -1;
    }
}

static void* background_flusher(void*) {
    // Continually poll the ring buffer every 500ms
    struct timespec ts;
    ts.tv_sec = 0;
    ts.tv_nsec = 500000000; // 500ms
    
    while (!is_shutting_down.load(std::memory_order_relaxed)) {
        flush_buffer(false);
        if (real_nanosleep) real_nanosleep(&ts, NULL);
    }
    return NULL;
}

void record_event(const char* name, void* addr, void* caller, uint64_t duration) {
    // Atomically claim the next slot in the ring buffer
    uint64_t idx = write_head.fetch_add(1, std::memory_order_relaxed);
    
    // Safety Fallback: If writers are lapping the slow disk reader, drop the event to prevent data corruption.
    // In a true Linux Kernel ring buffer, we'd stall the thread, but we must remain Wait-Free here.
    if (idx - read_tail.load(std::memory_order_relaxed) >= BUFFER_SIZE) {
        return; // Ring buffer full, dropping event (System is thrashing too hard!)
    }
    
    uint64_t ring_idx = idx % BUFFER_SIZE;
    
    if (my_tid == 0) my_tid = syscall(SYS_gettid);
    
    global_events[ring_idx].ts = get_time_us() - start_time_us;
    global_events[ring_idx].tid = my_tid;
    global_events[ring_idx].event_name = name;
    global_events[ring_idx].addr = addr;
    global_events[ring_idx].caller_addr = caller; 
    global_events[ring_idx].duration_us = duration;
}

// Ensure trace is flushed successfully when the process gracefully exits
__attribute__((destructor))
static void global_teardown() {
    if (!initialized || is_shutting_down.load()) return;
    is_shutting_down.store(true);
    
    if (real_join) {
        real_join(flusher_tid, NULL);
    }
    
    flush_buffer(true);
    printf("[CM_Hijacker] Output trace finalized.\n");
}

// --- THE INTERCEPTS (For Mutexes) ---

extern "C" int pthread_mutex_lock(pthread_mutex_t *mutex) {
    if (!initialized) initialize();
    if (in_tracer) return real_lock(mutex);

    in_tracer = 1;
    uint64_t t0 = get_time_us();
    void* caller = __builtin_return_address(0);
    
    if (my_tid == 0) my_tid = syscall(SYS_gettid);
    int wait_idx = -1;
    for (int i = 0; i < 256; i++) {
        if (__sync_bool_compare_and_swap(&active_waits[i].tid, 0, my_tid)) {
            wait_idx = i;
            active_waits[i].waiting_on_mutex = (void*)mutex;
            active_waits[i].wait_start_ts = t0;
            active_waits[i].caller_addr = caller;
            break;
        }
    }
    
    int result = real_lock(mutex); 
    
    uint64_t t1 = get_time_us();
    uint64_t wait_time = t1 - t0;
    
    if (wait_idx != -1) {
        active_waits[wait_idx].tid = 0;
    }
    
    record_event(wait_time > 20 ? "LOCK_WAIT" : "LOCK_ACQUIRE", (void*)mutex, caller, wait_time);
    hold_start_time = t1; 
    
    in_tracer = 0;
    return result;
}

extern "C" int pthread_mutex_unlock(pthread_mutex_t *mutex) {
    if (!initialized) initialize();
    if (in_tracer) return real_unlock(mutex);

    in_tracer = 1;
    uint64_t t0 = get_time_us();
    uint64_t hold_time = t0 - hold_start_time;
    
    void* caller = __builtin_return_address(0);
    
    record_event("LOCK_RELEASE", (void*)mutex, caller, hold_time);
    int result = real_unlock(mutex);
    
    in_tracer = 0;
    return result;
}

// --- THE INTERCEPTS (For Thread Lifecycle) ---
struct ThreadWrapperArgs {
    void *(*start_routine)(void *);
    void *arg;
    void *caller;
};

static void* cm_thread_wrapper(void* ptr) {
    ThreadWrapperArgs* args = (ThreadWrapperArgs*)ptr;
    void *(*routine)(void *) = args->start_routine;
    void *arg = args->arg;
    void *caller = args->caller;
    free(args);

    my_tid = syscall(SYS_gettid);
    record_event("THREAD_START", (void*)0x0, caller, 1);
    
    void* result = routine(arg);
    
    record_event("THREAD_END", (void*)0x0, caller, 1);
    return result;
}

extern "C" int pthread_create(pthread_t *thread, const pthread_attr_t *attr, void *(*start_routine) (void *), void *arg) {
    if (!initialized) initialize();
    if (in_tracer) return real_create(thread, attr, start_routine, arg);
    
    in_tracer = 1;
    void* caller = __builtin_return_address(0);
    ThreadWrapperArgs* w_args = (ThreadWrapperArgs*)malloc(sizeof(ThreadWrapperArgs));
    w_args->start_routine = start_routine;
    w_args->arg = arg;
    w_args->caller = caller;
    
    int result = real_create(thread, attr, cm_thread_wrapper, w_args);
    in_tracer = 0;
    return result;
}

extern "C" int pthread_join(pthread_t thread, void **retval) {
    if (!initialized) initialize();
    if (in_tracer) return real_join(thread, retval);
    in_tracer = 1;
    
    uint64_t t0 = get_time_us();
    void* caller = __builtin_return_address(0);
    
    int result = real_join(thread, retval);
    
    uint64_t t1 = get_time_us();
    record_event("THREAD_JOIN", (void*)thread, caller, t1 - t0);
    
    in_tracer = 0;
    return result;
}

// --- THE INTERCEPTS (For Cond Vars) ---
extern "C" int pthread_cond_wait(pthread_cond_t *cond, pthread_mutex_t *mutex) {
    if (!initialized) initialize();
    if (in_tracer) return real_cond_wait(cond, mutex);
    in_tracer = 1;
    
    uint64_t t0 = get_time_us();
    void* caller = __builtin_return_address(0);
    
    int result = real_cond_wait(cond, mutex);
    
    uint64_t t1 = get_time_us();
    record_event("COND_WAIT", (void*)cond, caller, t1 - t0);
    
    in_tracer = 0;
    return result;
}

extern "C" int pthread_cond_timedwait(pthread_cond_t *cond, pthread_mutex_t *mutex, const struct timespec *abstime) {
    if (!initialized) initialize();
    if (in_tracer) return real_cond_timedwait(cond, mutex, abstime);
    in_tracer = 1;
    
    uint64_t t0 = get_time_us();
    void* caller = __builtin_return_address(0);
    
    int result = real_cond_timedwait(cond, mutex, abstime);
    
    uint64_t t1 = get_time_us();
    record_event("COND_WAIT", (void*)cond, caller, t1 - t0);
    
    in_tracer = 0;
    return result;
}

// --- THE INTERCEPTS (For I/O) ---
extern "C" ssize_t read(int fd, void *buf, size_t count) {
    if (!initialized) initialize();
    if (in_tracer) return real_read(fd, buf, count);
    in_tracer = 1;
    
    uint64_t t0 = get_time_us();
    void* caller = __builtin_return_address(0);
    
    ssize_t result = real_read(fd, buf, count);
    
    uint64_t t1 = get_time_us();
    uint64_t duration = t1 - t0;
    if (duration > 50) {
        record_event("IO_WAIT", (void*)(uintptr_t)fd, caller, duration);
    }
    
    in_tracer = 0;
    return result;
}

extern "C" ssize_t write(int fd, const void *buf, size_t count) {
    if (!initialized) initialize();
    if (in_tracer) return real_write(fd, buf, count);
    in_tracer = 1;
    
    uint64_t t0 = get_time_us();
    void* caller = __builtin_return_address(0);
    
    ssize_t result = real_write(fd, buf, count);
    
    uint64_t t1 = get_time_us();
    uint64_t duration = t1 - t0;
    if (duration > 50) {
        record_event("IO_WAIT", (void*)(uintptr_t)fd, caller, duration);
    }
    
    in_tracer = 0;
    return result;
}

extern "C" ssize_t recv(int sockfd, void *buf, size_t len, int flags) {
    if (!initialized) initialize();
    if (in_tracer) return real_recv(sockfd, buf, len, flags);
    in_tracer = 1;
    
    uint64_t t0 = get_time_us();
    void* caller = __builtin_return_address(0);
    
    ssize_t result = real_recv(sockfd, buf, len, flags);
    
    uint64_t t1 = get_time_us();
    record_event("IO_WAIT", (void*)(uintptr_t)sockfd, caller, t1 - t0);
    
    in_tracer = 0;
    return result;
}

extern "C" ssize_t send(int sockfd, const void *buf, size_t len, int flags) {
    if (!initialized) initialize();
    if (in_tracer) return real_send(sockfd, buf, len, flags);
    in_tracer = 1;
    
    uint64_t t0 = get_time_us();
    void* caller = __builtin_return_address(0);
    
    ssize_t result = real_send(sockfd, buf, len, flags);
    
    uint64_t t1 = get_time_us();
    record_event("IO_WAIT", (void*)(uintptr_t)sockfd, caller, t1 - t0);
    
    in_tracer = 0;
    return result;
}

// --- THE INTERCEPTS (For Sleep) ---

extern "C" int nanosleep(const struct timespec *req, struct timespec *rem) {
    if (!initialized) initialize();
    if (in_tracer) return real_nanosleep(req, rem);

    in_tracer = 1;
    uint64_t t0 = get_time_us();
    void* caller = __builtin_return_address(0);
    
    int result = real_nanosleep(req, rem); // Actual sleep happens here
    
    uint64_t t1 = get_time_us();
    record_event("SLEEP", (void*)0x0, caller, t1 - t0);
    
    in_tracer = 0;
    return result;
}

extern "C" int clock_nanosleep(clockid_t clockid, int flags, const struct timespec *req, struct timespec *rem) {
    if (!initialized) initialize();
    if (in_tracer) return real_clock_nanosleep(clockid, flags, req, rem);

    in_tracer = 1;
    uint64_t t0 = get_time_us();
    void* caller = __builtin_return_address(0);
    
    int result = real_clock_nanosleep(clockid, flags, req, rem);
    
    uint64_t t1 = get_time_us();
    record_event("SLEEP", (void*)0x0, caller, t1 - t0);
    
    in_tracer = 0;
    return result;
}

extern "C" int usleep(useconds_t usec) {
    if (!initialized) initialize();
    if (in_tracer) return real_usleep(usec);

    in_tracer = 1;
    uint64_t t0 = get_time_us();
    void* caller = __builtin_return_address(0);
    
    int result = real_usleep(usec);
    
    uint64_t t1 = get_time_us();
    record_event("SLEEP", (void*)0x0, caller, t1 - t0);
    
    in_tracer = 0;
    return result;
}

// --- THE BACKDOOR (For CPU Compute Time) ---

extern "C" void cm_record_compute(const char* scenario, uint64_t duration_us) {
    if (!initialized) initialize();
    
    // We pass the string pointer as the caller_addr so write_trace can read it
    record_event("COMPUTE", (void*)0x0, (void*)scenario, duration_us); 
}

// --- THE EXPORTER ---

// END OF CM_HIJACKER