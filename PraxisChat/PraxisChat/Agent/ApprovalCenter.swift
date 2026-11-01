import Foundation
import AgentCore

/// The human side of `ToolPolicy.ask`. An engine awaits `decide`; the
/// approval card in the step resolves it. Every request resolves exactly
/// once: by the user, or `.deny` when the run is stopped or its task is
/// cancelled — a run can never hang on a card nobody will tap.
@MainActor
@Observable
final class ApprovalCenter: ApprovalHandler {
    private struct Waiter {
        let request: ApprovalRequest
        let continuation: CheckedContinuation<ApprovalDecision, Never>
    }

    @ObservationIgnored private var waiters: [String: Waiter] = [:]
    /// Ids currently waiting, for views and tests.
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
        // Cancelled before we got here: the cancel handler found nothing
        // to resolve, so answer now.
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
