#include <iostream>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <unistd.h>
#include <fcntl.h>

std::mutex mtx;
std::condition_variable cv;
bool ready = false;

void worker() {
    std::cout << "[Worker] Started thread execution.\n";
    usleep(50000); // Sleep for 50ms
    
    // Cond wait
    std::cout << "[Worker] Waiting on condition variable...\n";
    std::unique_lock<std::mutex> lock(mtx);
    cv.wait(lock, []{ return ready; });
    std::cout << "[Worker] Condition met! Proceeding.\n";
    
    // Some IO
    std::cout << "[Worker] Performing I/O...\n";
    int fd = open("/dev/null", O_WRONLY);
    if (fd != -1) {
        // We write enough to hopefully register a tiny IO wait, or we can just sleep inside a write if it was a pipe
        write(fd, "hello\n", 6);
        close(fd);
    }
    
    // Using a pipe to fake a long I/O wait
    int pipefd[2];
    if (pipe(pipefd) == 0) {
        // Child will write to pipe after 100ms
        if (fork() == 0) {
            usleep(100000); // 100ms
            write(pipefd[1], "test", 4);
            _exit(0);
        } else {
            char buf[10];
            std::cout << "[Worker] Waiting for I/O from pipe...\n";
            read(pipefd[0], buf, 4); // This will block for ~100ms
            close(pipefd[0]);
            close(pipefd[1]);
        }
    }

    std::cout << "[Worker] Exiting thread.\n";
}

int main() {
    std::cout << "[Main] Creating worker thread (Should log THREAD_START)...\n";
    std::thread t(worker);
    
    usleep(150000); // 150ms 
    
    std::cout << "[Main] Signaling condition variable...\n";
    {
        std::lock_guard<std::mutex> lock(mtx);
        ready = true;
    }
    cv.notify_one();
    
    std::cout << "[Main] Waiting for worker to join (Should log THREAD_JOIN)...\n";
    t.join();
    
    std::cout << "[Main] Done!\n";
    return 0;
}
