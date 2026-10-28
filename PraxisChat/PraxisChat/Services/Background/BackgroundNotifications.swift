import Foundation
import UIKit
import UserNotifications
import AgentCore

/// The seam `BackgroundNotifications` posts through. Main-actor bound:
/// `UNUserNotificationCenter` and `UNNotificationRequest` are not
/// Sendable, so everything stays on one domain and the live
/// implementation only ever makes synchronous calls into the center
/// (completion-handler based, wrapped in continuations) — nothing
/// crosses an isolation boundary.
@MainActor
protocol NotificationScheduling: Sendable {
    func requestAuthorization(options: UNAuthorizationOptions) async throws -> Bool
    func add(_ request: UNNotificationRequest) async throws
    func removePendingNotificationRequests(withIdentifiers: [String])
    func removeDeliveredNotifications(withIdentifiers: [String])
    /// Identifiers only (the requests themselves aren't Sendable):
    /// launch cleanup lists and filters by our prefixes.
    func deliveredIdentifiers() async -> [String]
    func pendingIdentifiers() async -> [String]
    func setNotificationCategories(_ categories: Set<UNNotificationCategory>)
    var delegate: (any UNUserNotificationCenterDelegate)? { get set }
}

/// The live center. Calls into `UNUserNotificationCenter` (thread-safe
/// by framework design) always happen on the main actor.
@MainActor
final class LiveNotificationCenter: NotificationScheduling {
    private let center = UNUserNotificationCenter.current()

    func requestAuthorization(options: UNAuthorizationOptions) async throws -> Bool {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Bool, Error>) in
            center.requestAuthorization(options: options) { granted, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: granted)
                }
            }
        }
    }

    func add(_ request: UNNotificationRequest) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            center.add(request) { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }

    func removePendingNotificationRequests(withIdentifiers identifiers: [String]) {
        center.removePendingNotificationRequests(withIdentifiers: identifiers)
    }

    func removeDeliveredNotifications(withIdentifiers identifiers: [String]) {
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
    }

    func deliveredIdentifiers() async -> [String] {
        await withCheckedContinuation { (continuation: CheckedContinuation<[String], Never>) in
            center.getDeliveredNotifications { notifications in
                continuation.resume(returning: notifications.map(\.request.identifier))
            }
        }
    }

    func pendingIdentifiers() async -> [String] {
        await withCheckedContinuation { (continuation: CheckedContinuation<[String], Never>) in
            center.getPendingNotificationRequests { requests in
                continuation.resume(returning: requests.map(\.identifier))
            }
        }
    }

    func setNotificationCategories(_ categories: Set<UNNotificationCategory>) {
        center.setNotificationCategories(categories)
    }

    var delegate: (any UNUserNotificationCenterDelegate)? {
        get { center.delegate }
        set { center.delegate = newValue }
    }
}

/// Where a notification interaction routes. Pure, so the mapping is
/// unit-testable without constructing a `UNNotificationResponse`
/// (which has no public initializer).
enum NotificationRoute: Equatable, Sendable {
    case approve(requestID: String, conversationID: UUID)
    case deny(requestID: String, conversationID: UUID)
    case openChat(conversationID: UUID)

    /// `actionID` is the tapped action (or
    /// `UNNotificationDefaultActionIdentifier` for a tap on the
    /// notification itself); `userInfo` is what we posted.
    static func resolve(actionID: String, userInfo: [AnyHashable: Any]) -> NotificationRoute? {
        guard let idString = userInfo["conversationID"] as? String,
              let conversationID = UUID(uuidString: idString) else { return nil }
        switch actionID {
        case BackgroundNotifications.approveActionID:
            guard let requestID = userInfo["requestID"] as? String else { return nil }
            return .approve(requestID: requestID, conversationID: conversationID)
        case BackgroundNotifications.denyActionID:
            guard let requestID = userInfo["requestID"] as? String else { return nil }
            return .deny(requestID: requestID, conversationID: conversationID)
        case UNNotificationDefaultActionIdentifier:
            return .openChat(conversationID: conversationID)
        default:
            return nil
        }
    }
}

/// Routes notification interactions: Approve/Deny decide through the
/// store, taps deep-link to the chat. Main-actor (the store is); the
/// two protocol witnesses are `nonisolated` and hop.
@MainActor
final class BackgroundNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    weak var store: ChatStore?
    /// UIKit open by default; tests inject a recorder.
    var openURL: ((URL) -> Void)?

    nonisolated func userNotificationCenter(_: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let route = NotificationRoute.resolve(actionID: response.actionIdentifier,
                                              userInfo: response.notification.request.content.userInfo)
        // The completion handler can't cross into the hop below (it isn't
        // Sendable), so it runs here: every route foregrounds the app
        // (`.foreground` actions, taps), which keeps the process alive
        // for the scheduled handling.
        Task { @MainActor [weak self] in self?.handle(route) }
        completionHandler()
    }

    nonisolated func userNotificationCenter(_: UNUserNotificationCenter,
                                            willPresent _: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        // We only post while backgrounded, so this just covers the race
        // of returning to the foreground mid-flight: still show it.
        completionHandler([.banner, .sound])
    }

    func handle(_ route: NotificationRoute?) {
        guard let route else { return }
        switch route {
        case .approve(let requestID, _):
            store?.resolveApproval(requestID, decision: .allowOnce)
        case .deny(let requestID, _):
            store?.resolveApproval(requestID, decision: .deny)
        case .openChat(let conversationID):
            if let url = BackgroundNotifications.chatURL(conversationID: conversationID) {
                if let openURL {
                    openURL(url)
                } else {
                    UIApplication.shared.open(url)
                }
            }
        }
    }
}

/// Approval and completion notifications for backgrounded runs, plus
/// the one-time permission gate (plan §2.5–2.6).
///
/// - Permission is requested the first time a run is backgrounded —
///   never at launch — and the prompt having been shown is persisted.
/// - Approvals post one notification per pending request id (category
///   `praxis.approval`, `.foreground` Approve/Deny actions), replaced
///   by identifier, withdrawn when the request resolves or the run
///   ends — but kept across a background pause (it still deep-links
///   back to the chat).
/// - Completions post the chat title plus the answer's first line
///   (~160 chars); failures post the short reason instead.
@MainActor
final class BackgroundNotifications: Sendable {
    static let approvalCategoryID = "praxis.approval"
    static let approveActionID = "praxis.approve"
    static let denyActionID = "praxis.deny"
    static let promptedFlagKey = "PraxisBackgroundNotificationsPrompted"
    static let completionBodyLimit = 160

    private let center: any NotificationScheduling
    private let defaults: UserDefaults
    let delegate = BackgroundNotificationDelegate()

    /// Posted approval request ids per conversation, for withdrawal.
    private var postedApprovals: [UUID: Set<String>] = [:]

    init(center: (any NotificationScheduling)? = nil, defaults: UserDefaults = .standard) {
        self.center = center ?? LiveNotificationCenter()
        self.defaults = defaults
    }

    var hasPrompted: Bool { defaults.bool(forKey: Self.promptedFlagKey) }

    /// Installed once from `ChatStore.forLaunch`.
    func installDelegate(store: ChatStore) {
        delegate.store = store
        var center = center
        center.delegate = delegate
    }

    /// Asks once, ever, the first time a run is backgrounded. Denied
    /// counts as asked (we must not nag); a thrown error doesn't (the
    /// next backgrounding retries).
    func ensureFirstRunPermission() async {
        guard !hasPrompted else { return }
        registerCategories()
        do {
            _ = try await center.requestAuthorization(options: [.alert, .sound])
            defaults.set(true, forKey: Self.promptedFlagKey)
        } catch {
            // Retry on the next backgrounded run.
        }
    }

    func postApproval(requestID: String, tool: String, chatTitle: String, conversationID: UUID) async {
        registerCategories()
        let content = UNMutableNotificationContent()
        content.categoryIdentifier = Self.approvalCategoryID
        content.title = "Praxis needs your approval"
        content.body = "\(tool) in \(chatTitle)"
        content.sound = .default
        content.userInfo = ["conversationID": conversationID.uuidString, "requestID": requestID]
        let identifier = Self.approvalIdentifier(requestID)
        center.removePendingNotificationRequests(withIdentifiers: [identifier])
        center.removeDeliveredNotifications(withIdentifiers: [identifier])
        try? await center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
        postedApprovals[conversationID, default: []].insert(requestID)
    }

    func withdrawApproval(_ requestID: String, conversationID: UUID) async {
        let identifier = Self.approvalIdentifier(requestID)
        center.removePendingNotificationRequests(withIdentifiers: [identifier])
        center.removeDeliveredNotifications(withIdentifiers: [identifier])
        postedApprovals[conversationID]?.remove(requestID)
    }

    /// Launch cleanup: a kill leaves delivered approval/completion cards
    /// behind as dead cards (their waiters are gone — taps would no-op),
    /// and the in-memory posting record with them. Drops everything under
    /// our prefixes; nothing else is touched.
    func clearRunNotifications() async {
        postedApprovals.removeAll()
        let ours = { (id: String) in
            id.hasPrefix("praxis.approval.") || id.hasPrefix("praxis.done.")
        }
        let delivered = await center.deliveredIdentifiers().filter(ours)
        if !delivered.isEmpty { center.removeDeliveredNotifications(withIdentifiers: delivered) }
        let pending = await center.pendingIdentifiers().filter(ours)
        if !pending.isEmpty { center.removePendingNotificationRequests(withIdentifiers: pending) }
    }

    /// Withdraws every approval posted for a conversation (run end, or
    /// a fresh run superseding a paused one).
    func withdrawApprovals(for conversationID: UUID) async {
        let ids = postedApprovals.removeValue(forKey: conversationID) ?? []
        guard !ids.isEmpty else { return }
        let identifiers = ids.map(Self.approvalIdentifier)
        center.removePendingNotificationRequests(withIdentifiers: identifiers)
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
    }

    func postCompletion(title: String, body: String, conversationID: UUID) async {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.userInfo = ["conversationID": conversationID.uuidString]
        let identifier = "praxis.done.\(conversationID.uuidString)"
        center.removePendingNotificationRequests(withIdentifiers: [identifier])
        center.removeDeliveredNotifications(withIdentifiers: [identifier])
        try? await center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
    }

    static func approvalIdentifier(_ requestID: String) -> String {
        "praxis.approval.\(requestID)"
    }

    static func chatURL(conversationID: UUID) -> URL? {
        URL(string: "praxis-app://chat/\(conversationID.uuidString)")
    }

    /// First non-empty line of the answer (~160 chars); failures read
    /// their short reason. Pure, for the mapping tests.
    static func completionBody(for turn: Turn) -> String {
        switch turn.outcome {
        case .completed, .none:
            for block in turn.blocks {
                if case .markdown(_, let source, _) = block {
                    let first = source.split(whereSeparator: \.isNewline)
                        .map { $0.trimmingCharacters(in: .whitespaces) }
                        .first { !$0.isEmpty }
                    if let first, !first.isEmpty {
                        return StepPresentation.clip(String(first), limit: completionBodyLimit) ?? "Done"
                    }
                }
            }
            return "Done"
        default:
            return turn.outcome?.note ?? "Couldn't finish"
        }
    }

    private func registerCategories() {
        let approve = UNNotificationAction(identifier: Self.approveActionID, title: "Approve", options: [.foreground])
        let deny = UNNotificationAction(identifier: Self.denyActionID, title: "Deny", options: [.foreground])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: Self.approvalCategoryID, actions: [approve, deny],
                                   intentIdentifiers: [], options: []),
        ])
    }
}
