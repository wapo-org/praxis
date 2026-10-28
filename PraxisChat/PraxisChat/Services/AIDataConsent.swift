import Foundation
import Observation

/// Which provider hosts the user has allowed to receive chat data
/// (App Review 5.1.2(i): name who gets personal data and ask first).
/// Keyed by host (with a non-default port), not by profile: two profiles
/// pointing at the same server share one decision, and editing a
/// profile's base URL to a new host asks again.
///
/// One small JSON file in Application Support, so `-PraxisResetData`
/// clears it with everything else. Revoked in Settings.
@MainActor
@Observable
final class AIDataConsent {
    struct Grant: Codable, Hashable, Identifiable {
        var host: String
        /// The profile name at the time, for the Settings list.
        var providerName: String
        var grantedAt: Date
        var id: String { host }
    }

    private struct File: Codable {
        var version = 1
        var grants: [Grant] = []
    }

    private(set) var grants: [Grant] = []
    /// nil keeps decisions in memory only (tests, previews).
    @ObservationIgnored let fileURL: URL?

    init(fileURL: URL?) {
        self.fileURL = fileURL
        if let fileURL, let data = try? Data(contentsOf: fileURL),
           let file = try? JSONDecoder().decode(File.self, from: data) {
            grants = file.grants
        }
    }

    /// `api.anthropic.com`, `192.168.1.20:1234`. Lowercased; the scheme
    /// is ignored (http vs https to one host is the same recipient).
    nonisolated static func host(of url: URL) -> String {
        let host = url.host()?.lowercased() ?? url.absoluteString.lowercased()
        return url.port.map { "\(host):\($0)" } ?? host
    }

    func isGranted(_ host: String) -> Bool { grants.contains { $0.host == host } }

    func isGranted(baseURL: URL) -> Bool { isGranted(Self.host(of: baseURL)) }

    func grant(_ host: String, providerName: String, at date: Date = Date()) {
        grants.removeAll { $0.host == host }
        grants.append(Grant(host: host, providerName: providerName, grantedAt: date))
        grants.sort { $0.host < $1.host }
        persist()
    }

    func revoke(_ host: String) {
        guard isGranted(host) else { return }
        grants.removeAll { $0.host == host }
        persist()
    }

    private func persist() {
        guard let fileURL else { return }
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            try encoder.encode(File(grants: grants)).write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            assertionFailure("AIDataConsent write failed: \(error)")
        }
    }
}

/// A live send held until the user answers the consent sheet.
struct ConsentRequest: Identifiable, Equatable {
    enum Action: Equatable {
        /// The composer's text and attachments, restored on decline.
        case send(text: String, attachments: [Attachment])
        case retry(UUID)
    }

    let id = UUID()
    var host: String
    var providerName: String
    /// Connectors on in this chat: what they return goes to the model too.
    var connectorNames: [String]
    /// The chat the held send belongs to: the answer returns there even if
    /// the selection moved while the sheet was up.
    var conversationID: UUID
    var action: Action
}
