#ifndef CM_ANNOTATE_H
#define CM_ANNOTATE_H

#include <chrono>
#include <cstddef>
#include <dlfcn.h>

// Function pointer type matching the backdoor in our hijacker
typedef void (*cm_record_compute_t)(const char*, uint64_t);
typedef void (*cm_record_mem_access_t)(const void*, size_t, const char*, const char*);
typedef void (*cm_record_lock_wait_t)(const void*, uint64_t, const char*, const char*);
typedef void (*cm_record_deadlock_t)(const void*, const char*);

inline void cm_emit_mem_access(const void* addr, size_t size, const char* kind, const char* scenario) {
    static cm_record_mem_access_t fn =
        (cm_record_mem_access_t)dlsym(RTLD_DEFAULT, "cm_record_mem_access");
    if (fn) {
        fn(addr, size, kind, scenario);
    }
}

inline void cm_emit_lock_wait(const void* resource, uint64_t duration_us, const char* event_name, const char* scenario) {
    static cm_record_lock_wait_t fn =
        (cm_record_lock_wait_t)dlsym(RTLD_DEFAULT, "cm_record_lock_wait");
    if (fn) {
        fn(resource, duration_us, event_name, scenario);
    }
}

inline void cm_emit_deadlock(const void* resource, const char* scenario) {
    static cm_record_deadlock_t fn =
        (cm_record_deadlock_t)dlsym(RTLD_DEFAULT, "cm_record_deadlock");
    if (fn) {
        fn(resource, scenario);
    }
}

class ComputeAnnotator {
    const char* m_scenario;
    std::chrono::high_resolution_clock::time_point m_start;
    cm_record_compute_t m_func;

public:
    ComputeAnnotator(const char* scenario) : m_scenario(scenario) {
        // Try to find the backdoor function injected by LD_PRELOAD
        m_func = (cm_record_compute_t)dlsym(RTLD_DEFAULT, "cm_record_compute");
        
        if (m_func) {
            m_start = std::chrono::high_resolution_clock::now();
        }
    }

    ~ComputeAnnotator() {
        if (m_func) {
            auto end = std::chrono::high_resolution_clock::now();
            uint64_t duration = std::chrono::duration_cast<std::chrono::microseconds>(end - m_start).count();
            m_func(m_scenario, duration);
        }
    }
};

// The Macro you will use in your code
#define CM_COMPUTE(scenario_name) ComputeAnnotator _cm_compute_guard(scenario_name)
#define CM_MEM_ACCESS(addr, size, kind, scenario_name) \
    cm_emit_mem_access((addr), (size), (kind), (scenario_name))
#define CM_LOCK_WAIT(resource, duration_us, scenario_name) \
    cm_emit_lock_wait((resource), (duration_us), "LOCK_WAIT", (scenario_name))
#define CM_LOCK_WAIT_TIMEOUT(resource, duration_us, scenario_name) \
    cm_emit_lock_wait((resource), (duration_us), "LOCK_WAIT_TIMEOUT", (scenario_name))
#define CM_DEADLOCK_DETECTED(resource, scenario_name) \
    cm_emit_deadlock((resource), (scenario_name))

#endif
