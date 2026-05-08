#include <atomic>
#include <chrono>
#include <iostream>
#include <mutex>
#include <thread>

#include "cm_annotate.h"

namespace {
std::timed_mutex g_a;
std::timed_mutex g_b;
std::atomic<bool> g_abort[2] = {false, false};

void run_worker(int self, int other, std::timed_mutex& first, std::timed_mutex& second, const char* scenario) {
    for (int round = 0; round < 4; ++round) {
        if (g_abort[self].exchange(false, std::memory_order_relaxed)) {
            CM_MEM_ACCESS(&g_abort[self], sizeof(g_abort[self]), "MEM_READ", "wound_wait_backoff");
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }

        first.lock();
        CM_COMPUTE("wound_wait_hold_first");
        std::this_thread::sleep_for(std::chrono::milliseconds(15));

        CM_MEM_ACCESS(&second, sizeof(second), "MEM_READ", "wound_wait_try_second");
        auto wait_start = std::chrono::high_resolution_clock::now();
        if (second.try_lock_for(std::chrono::milliseconds(20))) {
            auto wait_end = std::chrono::high_resolution_clock::now();
            auto wait_us = std::chrono::duration_cast<std::chrono::microseconds>(wait_end - wait_start).count();
            CM_LOCK_WAIT(&second, static_cast<uint64_t>(wait_us), "wound_wait_try_second");
            CM_COMPUTE("wound_wait_critical");
            std::this_thread::sleep_for(std::chrono::milliseconds(8));
            second.unlock();
            first.unlock();
            continue;
        }

        {
            auto wait_end = std::chrono::high_resolution_clock::now();
            auto wait_us = std::chrono::duration_cast<std::chrono::microseconds>(wait_end - wait_start).count();
            CM_LOCK_WAIT_TIMEOUT(&second, static_cast<uint64_t>(wait_us), "wound_wait_try_second");
        }

        // Older thread "wounds" the younger one; younger thread backs off.
        if (self < other) {
            CM_MEM_ACCESS(&g_abort[other], sizeof(g_abort[other]), "MEM_WRITE", "wound_younger");
            g_abort[other].store(true, std::memory_order_relaxed);
        } else {
            CM_MEM_ACCESS(&g_abort[self], sizeof(g_abort[self]), "MEM_READ", "wait_for_retry");
        }

        first.unlock();
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        --round;
    }

    CM_COMPUTE(scenario);
}

void thread0() {
    run_worker(0, 1, g_a, g_b, "wound_wait_thread_0");
}

void thread1() {
    run_worker(1, 0, g_b, g_a, "wound_wait_thread_1");
}
} // namespace

int main() {
    std::cout << "Wound-wait demo running...\n";

    std::thread t0(thread0);
    std::thread t1(thread1);
    t0.join();
    t1.join();

    std::cout << "Wound-wait demo complete.\n";
    return 0;
}
