#include <iostream>
#include <thread>
#include <vector>
#include <mutex>
#include <condition_variable>
#include <queue>
#include <chrono>
#include <unistd.h>
#include <fcntl.h>
#include <sys/wait.h>
#include <cmath>

#include "cm_annotate.h" // Hook into the tracer

std::mutex queue_mutex;
std::condition_variable cv;
std::queue<int> task_queue;
bool finished = false;

// Simulated IO job
void perform_io(int id) {
    CM_COMPUTE("Prepare_IO");
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
    
    // Simulate disk/network I/O by reading from a pipe
    int pipefd[2];
    if (pipe(pipefd) == 0) {
        pid_t pid = fork();
        if (pid == 0) {
            // Child process delays then writes, causing parent to wait
            std::this_thread::sleep_for(std::chrono::milliseconds(id * 15 + 10));
            write(pipefd[1], "data", 4);
            _exit(0);
        } else {
            // Parent reads, generating an IO_WAIT event
            char buf[10];
            read(pipefd[0], buf, 4); 
            close(pipefd[0]);
            close(pipefd[1]);
            waitpid(pid, NULL, 0); // Cleanup child
        }
    }
}

// Simulated CPU job
void perform_compute(int id) {
    {
        CM_COMPUTE("Heavy_Calculation");
        // Simulated busy loop
        volatile double work = 0.0;
        for(int i = 0; i < 3000000; i++) {
            work += std::sin(i) * std::cos(i);
        }
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
}

void producer_thread(int count) {
    for (int i = 0; i < count; ++i) {
        std::this_thread::sleep_for(std::chrono::milliseconds(25)); // Delay between task generation
        {
            std::lock_guard<std::mutex> lock(queue_mutex);
            task_queue.push(i);
        }
        cv.notify_one();
    }
}

void consumer_thread(int consumer_id) {
    while (true) {
        int task = -1;
        {
            // Worker is idle, waiting on task queue condition variable
            std::unique_lock<std::mutex> lock(queue_mutex);
            cv.wait(lock, []{ return !task_queue.empty() || finished; }); 
            
            if (finished && task_queue.empty()) {
                break;
            }
            
            task = task_queue.front();
            task_queue.pop();
        }
        
        // Process task
        if (task % 2 == 0) {
            perform_io(consumer_id);
        } else {
            perform_compute(consumer_id);
        }
    }
}

int main() {
    std::cout << "Starting Producer-Consumer Multithreaded Simulation...\n";
    std::vector<std::thread> consumers;
    
    // Spawn 4 consumer workers
    for (int i = 1; i <= 4; ++i) {
        consumers.emplace_back(consumer_thread, i);
    }
    
    // Spawn 1 producer
    std::thread producer(producer_thread, 20); // Produce 20 tasks
    
    // Wait for producer
    producer.join(); 
    
    // Signal completion
    {
        std::lock_guard<std::mutex> lock(queue_mutex);
        finished = true;
    }
    cv.notify_all();
    
    // Wait for all consumers to finish
    for (auto& consumer : consumers) {
        consumer.join(); 
    }
    
    std::cout << "Simulation Finished Successfully.\n";
    return 0;
}
