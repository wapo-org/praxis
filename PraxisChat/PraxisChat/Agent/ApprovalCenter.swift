import Foundation
import AgentCore

/// Every approval resolves once (user or .deny on cancel) so a run never hangs.
@MainActor
@Observable
final class ApprovalCenter: ApprovalHandler {
    private struct Waiter {
        let request: ApprovalRequest
        let continuation: CheckedContinuation<ApprovalDecision, Never>
    }

    @ObservationIgnored private var waiters: [String: Waiter] = [:]
    private(set) var pendingIDs: Set<String> = []

    nonisolated init() {}

    nonisolated func decide(_ request: ApprovalRequest) async -> ApprovalDecision {
        await withTaskCancellationHandler {
            await self.wait(for: request)
        } onCancel: {
            Task { @MainActor in self.resolve(request.id, with: .deny) }
        }
    }

    private func wait(for request: ApprovalRequest) async -> ApprovalDecision {
        // Cancel handler ran before registration, so return .deny immediately.
        if Task.isCancelled { return .deny }
        // A duplicate id would orphan the first waiter: deny it.
        resolve(request.id, with: .deny)
        return await withCheckedContinuation { continuation in
            waiters[request.id] = Waiter(request: request, continuation: continuation)
            pendingIDs.insert(request.id)
        }
    }

    func resolve(_ id: String, with decision: ApprovalDecision) {
        guard let waiter = waiters.removeValue(forKey: id) else { return }
        pendingIDs.remove(id)
        waiter.continuation.resume(returning: decision)
    }

    func denyAll(_ ids: some Sequence<String>) {
        for id in ids { resolve(id, with: .deny) }
    }

    func request(for id: String) -> ApprovalRequest? { waiters[id]?.request }
}
