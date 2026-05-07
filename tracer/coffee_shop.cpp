#include <iostream>
#include <thread>
#include <mutex>
#include <chrono>

#include "cm_annotate.h" // Optional: using your tracer's header

std::mutex resource_A;
std::mutex resource_B;

void thread_1_routine() {
    std::cout << "[Thread 1] Trying to lock Resource A...\n";
    resource_A.lock();
    std::cout << "[Thread 1] SUCCESS: Locked Resource A.\n";

    // Sleep to ensure Thread 2 has time to lock Resource B
    std::this_thread::sleep_for(std::chrono::milliseconds(50));

    std::cout << "[Thread 1] Trying to lock Resource B (Currently held by Thread 2)...\n";
    // It will get permanently stuck right here
    resource_B.lock(); 
    
    std::cout << "[Thread 1] SUCCESS: Locked Resource B! (You will never see this print)\n";

    resource_B.unlock();
    resource_A.unlock();
}

void thread_2_routine() {
    std::cout << "[Thread 2] Trying to lock Resource B...\n";
    resource_B.lock();
    std::cout << "[Thread 2] SUCCESS: Locked Resource B.\n";

    // Sleep to ensure Thread 1 has time to lock Resource A
    std::this_thread::sleep_for(std::chrono::milliseconds(50));

    std::cout << "[Thread 2] Trying to lock Resource A (Currently held by Thread 1)...\n";
    // It will get permanently stuck right here
    resource_A.lock();
    
    std::cout << "[Thread 2] SUCCESS: Locked Resource A! (You will never see this print)\n";

    resource_A.unlock();
    resource_B.unlock();
}

int main() {
    std::cout << "Starting Deadlock Simulation...\n";
    std::cout << "Press Ctrl+C to kill the program when it freezes.\n\n";

    std::thread t1(thread_1_routine);
    std::thread t2(thread_2_routine);

    t1.join();
    t2.join();

    std::cout << "Simulation Finished! (You will never see this print either)\n";
    return 0;
}