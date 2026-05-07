#ifndef CM_ANNOTATE_H
#define CM_ANNOTATE_H

#include <chrono>
#include <dlfcn.h>

// Function pointer type matching the backdoor in our hijacker
typedef void (*cm_record_compute_t)(const char*, uint64_t);

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

#endif