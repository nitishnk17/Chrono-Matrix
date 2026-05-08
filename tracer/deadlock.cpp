#include <chrono>
#include <iostream>
#include <mutex>
#include <thread>

#include "cm_annotate.h"

namespace {
std::timed_mutex g_left;
std::timed_mutex g_right;

void thread_left_first() {
    CM_MEM_ACCESS(&g_left, sizeof(g_left), "MEM_READ", "lock_left");
    g_left.lock();
    std::this_thread::sleep_for(std::chrono::milliseconds(50));

    CM_MEM_ACCESS(&g_right, sizeof(g_right), "MEM_READ", "lock_right");
    auto wait_start = std::chrono::high_resolution_clock::now();
    if (!g_right.try_lock_for(std::chrono::milliseconds(80))) {
        auto wait_end = std::chrono::high_resolution_clock::now();
        auto wait_us = std::chrono::duration_cast<std::chrono::microseconds>(wait_end - wait_start).count();
        CM_LOCK_WAIT_TIMEOUT(&g_right, static_cast<uint64_t>(wait_us), "deadlock_ab");
        CM_DEADLOCK_DETECTED(&g_right, "deadlock_ab");
        g_left.unlock();
        return;
    }

    g_right.unlock();
    g_left.unlock();
}

void thread_right_first() {
    CM_MEM_ACCESS(&g_right, sizeof(g_right), "MEM_READ", "lock_right");
    g_right.lock();
    std::this_thread::sleep_for(std::chrono::milliseconds(50));

    CM_MEM_ACCESS(&g_left, sizeof(g_left), "MEM_READ", "lock_left");
    auto wait_start = std::chrono::high_resolution_clock::now();
    if (!g_left.try_lock_for(std::chrono::milliseconds(80))) {
        auto wait_end = std::chrono::high_resolution_clock::now();
        auto wait_us = std::chrono::duration_cast<std::chrono::microseconds>(wait_end - wait_start).count();
        CM_LOCK_WAIT_TIMEOUT(&g_left, static_cast<uint64_t>(wait_us), "deadlock_ba");
        CM_DEADLOCK_DETECTED(&g_left, "deadlock_ba");
        g_right.unlock();
        return;
    }

    g_left.unlock();
    g_right.unlock();
}
} // namespace

int main() {
    std::cout << "Deadlock demo running...\n";

    std::thread t1(thread_left_first);
    std::thread t2(thread_right_first);
    t1.join();
    t2.join();

    std::cout << "Deadlock demo complete.\n";
    return 0;
}
