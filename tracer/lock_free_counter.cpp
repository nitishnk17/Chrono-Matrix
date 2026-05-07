#include <array>
#include <atomic>
#include <chrono>
#include <iostream>
#include <thread>
#include <vector>

#include "cm_annotate.h"

namespace {
constexpr int kThreadCount = 6;
constexpr int kIterations = 1200;

std::atomic<int> g_counter{0};
std::array<std::atomic<int>, kThreadCount> g_thread_counts = {};

void worker(int tid) {
    for (int i = 0; i < kIterations; ++i) {
        CM_COMPUTE("lock_free_increment");
        int prev = g_counter.fetch_add(1, std::memory_order_relaxed);
        (void)prev;

        CM_MEM_ACCESS(&g_counter, sizeof(g_counter), "MEM_WRITE", "atomic_increment");
        g_thread_counts[tid].fetch_add(1, std::memory_order_relaxed);

        if ((i % 200) == 0) {
            std::this_thread::sleep_for(std::chrono::milliseconds(1 + tid % 2));
        }
    }
}
} // namespace

int main() {
    std::cout << "Lock-free counter demo running...\n";

    std::vector<std::thread> threads;
    threads.reserve(kThreadCount);
    for (int i = 0; i < kThreadCount; ++i) {
        threads.emplace_back(worker, i);
    }

    for (auto& t : threads) {
        t.join();
    }

    std::cout << "Final counter: " << g_counter.load(std::memory_order_relaxed) << "\n";
    std::cout << "Lock-free counter demo complete.\n";
    return 0;
}
