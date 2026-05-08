#include <array>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include <unistd.h>

#include "cm_annotate.h"

namespace {
constexpr int kQueueCapacity = 6;
constexpr int kProducerCount = 2;
constexpr int kConsumerCount = 2;
constexpr int kUnevenWorkerCount = 5;
constexpr int kLockFreeWorkers = 4;

std::mutex g_queue_mutex;
std::condition_variable g_queue_cv;
std::deque<int> g_queue;
bool g_queue_done = false;

std::mutex g_hot_mutex;
std::atomic<int> g_hot_counter{0};

std::timed_mutex g_deadlock_left;
std::timed_mutex g_deadlock_right;

std::atomic<int> g_lock_free_counter{0};

std::array<std::atomic<int>, kProducerCount> g_producer_progress{};
std::array<std::atomic<int>, kConsumerCount> g_consumer_progress{};
std::array<std::atomic<int>, kUnevenWorkerCount> g_uneven_progress{};
std::array<std::atomic<int>, kLockFreeWorkers> g_lock_free_progress{};

std::array<int, kUnevenWorkerCount> g_work_units = {4, 10, 2, 18, 7};

void busy_compute(const char* scenario, int loops) {
    CM_COMPUTE(scenario);
    volatile double sink = 0.0;
    for (int i = 0; i < loops; ++i) {
        sink += (i % 7) * 0.00001;
    }
    if (sink < 0) {
        std::cout << sink;
    }
}

void run_memory_lifecycle_phase() {
    const size_t count = 256;
    int* scratch = new int[count];
    CM_MEM_ACCESS(scratch, count * sizeof(int), "MEM_ALLOC", "allocate_master_scratch");

    for (size_t i = 0; i < count; ++i) {
        CM_MEM_ACCESS(&scratch[i], sizeof(int), "MEM_WRITE", "seed_master_scratch");
        scratch[i] = static_cast<int>(i * 3);
    }

    for (size_t i = 0; i < count; i += 8) {
        CM_MEM_ACCESS(&scratch[i], sizeof(int), "MEM_READ", "scan_master_scratch");
        scratch[i] += 1;
    }

    CM_MEM_ACCESS(scratch, count * sizeof(int), "MEM_FREE", "release_master_scratch");
    delete[] scratch;
}

void producer(int id) {
    for (int i = 0; i < 10; ++i) {
        busy_compute("producer_prepare", 12000 + id * 1200);
        std::unique_lock<std::mutex> lock(g_queue_mutex);
        g_queue_cv.wait(lock, [] { return g_queue.size() < kQueueCapacity; });

        int value = id * 1000 + i;
        CM_MEM_ACCESS(&g_queue, sizeof(g_queue), "MEM_WRITE", "queue_push");
        g_queue.push_back(value);
        CM_MEM_ACCESS(&g_producer_progress[id], sizeof(g_producer_progress[id]), "MEM_WRITE", "producer_progress");
        g_producer_progress[id].store(i + 1, std::memory_order_relaxed);
        g_queue_cv.notify_one();
        if ((i % 3) == 0) {
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    }
}

void consumer(int id) {
    while (true) {
        int item = -1;
        {
            std::unique_lock<std::mutex> lock(g_queue_mutex);
            g_queue_cv.wait(lock, [] { return g_queue_done || !g_queue.empty(); });
            CM_MEM_ACCESS(&g_queue_done, sizeof(g_queue_done), "MEM_READ", "consumer_check_done");
            if (g_queue_done && g_queue.empty()) {
                break;
            }
            CM_MEM_ACCESS(&g_queue, sizeof(g_queue), "MEM_READ", "queue_pop");
            item = g_queue.front();
            g_queue.pop_front();
            g_queue_cv.notify_one();
        }

        busy_compute("consumer_process", 10000 + id * 900);
        CM_MEM_ACCESS(&g_consumer_progress[id], sizeof(g_consumer_progress[id]), "MEM_WRITE", "consumer_progress");
        g_consumer_progress[id].store(item >= 0 ? item : 0, std::memory_order_relaxed);
        if ((item % 4) == 0) {
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    }
}

void run_queue_phase() {
    std::vector<std::thread> producers;
    std::vector<std::thread> consumers;
    producers.reserve(kProducerCount);
    consumers.reserve(kConsumerCount);

    for (int i = 0; i < kProducerCount; ++i) {
        producers.emplace_back(producer, i);
    }
    for (int i = 0; i < kConsumerCount; ++i) {
        consumers.emplace_back(consumer, i);
    }

    for (auto& t : producers) {
        t.join();
    }

    {
        std::lock_guard<std::mutex> lock(g_queue_mutex);
        CM_MEM_ACCESS(&g_queue_done, sizeof(g_queue_done), "MEM_WRITE", "queue_done");
        g_queue_done = true;
    }
    g_queue_cv.notify_all();

    for (auto& t : consumers) {
        t.join();
    }
}

void uneven_worker(int id) {
    CM_MEM_ACCESS(&g_work_units[id], sizeof(g_work_units[id]), "MEM_READ", "read_workload");
    const int units = g_work_units[id];
    for (int u = 0; u < units; ++u) {
        busy_compute("uneven_work_chunk", 8000 + id * 2400);
        CM_MEM_ACCESS(&g_uneven_progress[id], sizeof(g_uneven_progress[id]), "MEM_WRITE", "uneven_progress");
        g_uneven_progress[id].store(u + 1, std::memory_order_relaxed);
        if (((u + id) % 4) == 0) {
            std::this_thread::sleep_for(std::chrono::milliseconds(1 + (id % 2)));
        }
    }
}

void run_uneven_phase() {
    std::vector<std::thread> threads;
    threads.reserve(kUnevenWorkerCount);
    for (int i = 0; i < kUnevenWorkerCount; ++i) {
        threads.emplace_back(uneven_worker, i);
    }
    for (auto& t : threads) {
        t.join();
    }
}

void hot_owner() {
    std::lock_guard<std::mutex> lock(g_hot_mutex);
    CM_MEM_ACCESS(&g_hot_counter, sizeof(g_hot_counter), "MEM_READ", "hot_owner_read");
    busy_compute("hot_owner_compute", 38000);
    std::this_thread::sleep_for(std::chrono::milliseconds(35));
    CM_MEM_ACCESS(&g_hot_counter, sizeof(g_hot_counter), "MEM_WRITE", "hot_owner_write");
    g_hot_counter.fetch_add(1, std::memory_order_relaxed);
}

void hot_waiter(int id) {
    std::this_thread::sleep_for(std::chrono::milliseconds(5 + id * 3));
    CM_MEM_ACCESS(&g_hot_counter, sizeof(g_hot_counter), "MEM_READ", "hot_waiter_read");
    std::lock_guard<std::mutex> lock(g_hot_mutex);
    busy_compute("hot_waiter_compute", 18000 + id * 1000);
    CM_MEM_ACCESS(&g_hot_counter, sizeof(g_hot_counter), "MEM_WRITE", "hot_waiter_write");
    g_hot_counter.fetch_add(1, std::memory_order_relaxed);
}

void run_lock_contention_phase() {
    std::thread owner(hot_owner);
    std::thread waiter1(hot_waiter, 0);
    std::thread waiter2(hot_waiter, 1);
    owner.join();
    waiter1.join();
    waiter2.join();
}

void io_reader(int fd) {
    char buffer[128] = {};
    busy_compute("io_reader_prepare", 6000);
    ssize_t n = read(fd, buffer, sizeof(buffer));
    if (n > 0) {
        CM_MEM_ACCESS(buffer, static_cast<size_t>(n), "MEM_READ", "io_read_buffer");
    }
}

void io_writer(int fd) {
    std::this_thread::sleep_for(std::chrono::milliseconds(30));
    std::string payload = "master_io_payload";
    CM_MEM_ACCESS(payload.data(), payload.size(), "MEM_WRITE", "io_write_payload");
    const ssize_t written = write(fd, payload.data(), payload.size());
    (void)written;
}

void run_io_phase() {
    int pipe_fds[2];
    if (pipe(pipe_fds) != 0) {
        std::perror("pipe");
        return;
    }

    std::thread reader(io_reader, pipe_fds[0]);
    std::thread writer(io_writer, pipe_fds[1]);
    reader.join();
    writer.join();

    close(pipe_fds[0]);
    close(pipe_fds[1]);
}

void deadlock_left() {
    CM_MEM_ACCESS(&g_deadlock_left, sizeof(g_deadlock_left), "MEM_READ", "deadlock_left_lock");
    g_deadlock_left.lock();
    std::this_thread::sleep_for(std::chrono::milliseconds(25));

    CM_MEM_ACCESS(&g_deadlock_right, sizeof(g_deadlock_right), "MEM_READ", "deadlock_left_try_right");
    const auto wait_start = std::chrono::high_resolution_clock::now();
    if (!g_deadlock_right.try_lock_for(std::chrono::milliseconds(60))) {
        const auto wait_end = std::chrono::high_resolution_clock::now();
        const auto wait_us = std::chrono::duration_cast<std::chrono::microseconds>(wait_end - wait_start).count();
        CM_LOCK_WAIT_TIMEOUT(&g_deadlock_right, static_cast<uint64_t>(wait_us), "master_deadlock_left");
        CM_DEADLOCK_DETECTED(&g_deadlock_right, "master_deadlock_left");
        g_deadlock_left.unlock();
        return;
    }

    g_deadlock_right.unlock();
    g_deadlock_left.unlock();
}

void deadlock_right() {
    CM_MEM_ACCESS(&g_deadlock_right, sizeof(g_deadlock_right), "MEM_READ", "deadlock_right_lock");
    g_deadlock_right.lock();
    std::this_thread::sleep_for(std::chrono::milliseconds(25));

    CM_MEM_ACCESS(&g_deadlock_left, sizeof(g_deadlock_left), "MEM_READ", "deadlock_right_try_left");
    const auto wait_start = std::chrono::high_resolution_clock::now();
    if (!g_deadlock_left.try_lock_for(std::chrono::milliseconds(60))) {
        const auto wait_end = std::chrono::high_resolution_clock::now();
        const auto wait_us = std::chrono::duration_cast<std::chrono::microseconds>(wait_end - wait_start).count();
        CM_LOCK_WAIT_TIMEOUT(&g_deadlock_left, static_cast<uint64_t>(wait_us), "master_deadlock_right");
        CM_DEADLOCK_DETECTED(&g_deadlock_left, "master_deadlock_right");
        g_deadlock_right.unlock();
        return;
    }

    g_deadlock_left.unlock();
    g_deadlock_right.unlock();
}

void run_deadlock_phase() {
    std::thread t1(deadlock_left);
    std::thread t2(deadlock_right);
    t1.join();
    t2.join();
}

void lock_free_worker(int id) {
    for (int i = 0; i < 500; ++i) {
        busy_compute("lock_free_increment", 5000 + id * 700);
        g_lock_free_counter.fetch_add(1, std::memory_order_relaxed);
        CM_MEM_ACCESS(&g_lock_free_counter, sizeof(g_lock_free_counter), "MEM_WRITE", "lock_free_increment");
        CM_MEM_ACCESS(&g_lock_free_progress[id], sizeof(g_lock_free_progress[id]), "MEM_WRITE", "lock_free_progress");
        g_lock_free_progress[id].fetch_add(1, std::memory_order_relaxed);
        if ((i % 150) == 0) {
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    }
}

void run_lock_free_phase() {
    std::vector<std::thread> threads;
    threads.reserve(kLockFreeWorkers);
    for (int i = 0; i < kLockFreeWorkers; ++i) {
        threads.emplace_back(lock_free_worker, i);
    }
    for (auto& t : threads) {
        t.join();
    }
    CM_MEM_ACCESS(&g_lock_free_counter, sizeof(g_lock_free_counter), "MEM_READ", "lock_free_readback");
}
} // namespace

int main() {
    std::cout << "Chrono-Matrix master multithread demo running...\n";
    run_memory_lifecycle_phase();
    run_queue_phase();
    run_uneven_phase();
    run_lock_contention_phase();
    run_io_phase();
    run_deadlock_phase();
    run_lock_free_phase();
    std::cout << "Final counter: " << g_lock_free_counter.load(std::memory_order_relaxed) << "\n";
    std::cout << "Chrono-Matrix master multithread demo complete.\n";
    return 0;
}
