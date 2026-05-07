#include <condition_variable>
#include <deque>
#include <iostream>
#include <mutex>
#include <thread>
#include <vector>

#include "cm_annotate.h"

namespace {
constexpr int kCapacity = 6;
constexpr int kItemsPerProducer = 18;

std::mutex g_mutex;
std::condition_variable g_not_full;
std::condition_variable g_not_empty;
std::deque<int> g_buffer;
bool g_done = false;

void producer(int id, int base_value) {
    for (int i = 0; i < kItemsPerProducer; ++i) {
        CM_COMPUTE("producer_prepare");
        std::this_thread::sleep_for(std::chrono::milliseconds(3 + (id % 2)));

        std::unique_lock<std::mutex> lock(g_mutex);
        g_not_full.wait(lock, [] { return g_buffer.size() < kCapacity; });

        int value = base_value + i;
        CM_MEM_ACCESS(&g_buffer, sizeof(g_buffer), "MEM_WRITE", "enqueue_item");
        g_buffer.push_back(value);
        g_not_empty.notify_one();
    }
}

void consumer(int id) {
    while (true) {
        int item = -1;
        {
            std::unique_lock<std::mutex> lock(g_mutex);
            g_not_empty.wait(lock, [] { return g_done || !g_buffer.empty(); });

            CM_MEM_ACCESS(&g_done, sizeof(g_done), "MEM_READ", "check_done");
            if (g_done && g_buffer.empty()) {
                break;
            }

            CM_MEM_ACCESS(&g_buffer, sizeof(g_buffer), "MEM_READ", "dequeue_item");
            item = g_buffer.front();
            g_buffer.pop_front();
            g_not_full.notify_one();
        }

        CM_COMPUTE("consumer_process");
        std::this_thread::sleep_for(std::chrono::milliseconds(4 + (id % 3)));
        (void)item;
    }
}
} // namespace

int main() {
    std::cout << "Producer-Consumer demo running...\n";

    std::vector<std::thread> producers;
    std::vector<std::thread> consumers;

    for (int i = 0; i < 2; ++i) {
        producers.emplace_back(producer, i, i * 100);
    }
    for (int i = 0; i < 3; ++i) {
        consumers.emplace_back(consumer, i);
    }

    for (auto& t : producers) {
        t.join();
    }

    {
        std::lock_guard<std::mutex> lock(g_mutex);
        CM_MEM_ACCESS(&g_done, sizeof(g_done), "MEM_WRITE", "set_done");
        g_done = true;
    }
    g_not_empty.notify_all();

    for (auto& t : consumers) {
        t.join();
    }

    std::cout << "Producer-Consumer demo complete.\n";
    return 0;
}
