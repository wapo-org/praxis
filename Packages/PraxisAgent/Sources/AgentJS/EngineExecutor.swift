import Foundation

/// A serial executor backed by one dedicated thread.
///
/// QuickJS runtimes are single-threaded and measure stack depth from the
/// thread they run on, so everything that touches the engine runs here:
/// a fixed thread with a stack large enough for the engine's own 512 KB
/// budget plus host frames, off the cooperative pool (a busy script must
/// never starve Swift concurrency's worker threads).
final class EngineExecutor: SerialExecutor, @unchecked Sendable {
    private let queue: JobQueue

    init(name: String, stackSize: Int) {
        let queue = JobQueue()
        self.queue = queue
        let thread = Thread { queue.run() }
        thread.name = name
        thread.stackSize = stackSize
        thread.qualityOfService = .userInitiated
        // The executor reference must exist before the first job can run;
        // jobs only arrive after `init` returns.
        queue.executor = { [unowned self] in self.asUnownedSerialExecutor() }
        thread.start()
    }

    deinit { queue.close() }

    func enqueue(_ job: consuming ExecutorJob) {
        queue.push(UnownedJob(job))
    }

    func checkIsolated() {
        precondition(queue.isCurrentThread, "Expected to run on the JavaScript engine thread")
    }
}

/// FIFO of jobs plus the loop that drains it on the engine thread.
private final class JobQueue: @unchecked Sendable {
    private let condition = NSCondition()
    private var jobs: [UnownedJob] = []
    private var head = 0
    private var closed = false
    private var thread: pthread_t?
    var executor: (() -> UnownedSerialExecutor)?

    func push(_ job: UnownedJob) {
        condition.lock()
        jobs.append(job)
        condition.signal()
        condition.unlock()
    }

    func close() {
        condition.lock()
        closed = true
        condition.signal()
        condition.unlock()
    }

    var isCurrentThread: Bool {
        condition.lock()
        defer { condition.unlock() }
        guard let thread else { return false }
        return pthread_equal(thread, pthread_self()) != 0
    }

    func run() {
        condition.lock()
        thread = pthread_self()
        condition.unlock()
        while true {
            condition.lock()
            while head == jobs.count && !closed { condition.wait() }
            if head == jobs.count && closed {
                condition.unlock()
                return
            }
            let job = jobs[head]
            head += 1
            if head > 64 && head * 2 > jobs.count {
                jobs.removeFirst(head)
                head = 0
            }
            let executor = self.executor
            condition.unlock()
            if let executor { job.runSynchronously(on: executor()) }
        }
    }
}
