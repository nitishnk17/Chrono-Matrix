#include <array>
#include <atomic>
#include <condition_variable>
#include <iostream>
#include <mutex>
#include <thread>
#include <vector>

#include "cm_annotate.h"

namespace {
constexpr int kThreadCount = 5;
constexpr std::array<int, kThreadCount> kWorkUnits = {6, 18, 4, 28, 10};

std::mutex g_start_mutex;
std::condition_variable g_start_cv;
bool g_start = false;

std::array<std::atomic<int>, kThreadCount> g_completed = {};

void burn_cpu(int thread_id, int work_units) {
    for (int unit = 0; unit < work_units; ++unit) {
        CM_COMPUTE("uneven_work_chunk");
        volatile double x = 0.0;
        for (int i = 0; i < 30000 + thread_id * 5000; ++i) {
            x += (i % 7) * 0.00001;
        }
        (void)x;

        CM_MEM_ACCESS(&g_completed[thread_id], sizeof(g_completed[thread_id]), "MEM_WRITE", "publish_progress");
        g_completed[thread_id].store(unit + 1, std::memory_order_relaxed);
    }
}

void worker(int thread_id) {
    {
        std::unique_lock<std::mutex> lock(g_start_mutex);
        g_start_cv.wait(lock, [] { return g_start; });
    }

    CM_MEM_ACCESS(&kWorkUnits[thread_id], sizeof(kWorkUnits[thread_id]), "MEM_READ", "read_workload");
    burn_cpu(thread_id, kWorkUnits[thread_id]);
}
} // namespace

int main() {
    std::cout << "Uneven work distribution demo running...\n";

    std::vector<std::thread> threads;
    threads.reserve(kThreadCount);
    for (int i = 0; i < kThreadCount; ++i) {
        threads.emplace_back(worker, i);
    }

    {
        std::lock_guard<std::mutex> lock(g_start_mutex);
        g_start = true;
    }
    g_start_cv.notify_all();

    for (auto& t : threads) {
        t.join();
    }

    std::cout << "Uneven work distribution demo complete.\n";
    return 0;
}
