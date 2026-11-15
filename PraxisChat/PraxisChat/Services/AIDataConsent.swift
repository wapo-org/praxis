import Foundation
import Observation

/// App Review 5.1.2(i) consent keyed by host(+port), not profile, so URL changes re-prompt.
@MainActor
@Observable
final class AIDataConsent {
    struct Grant: Codable, Hashable, Identifiable {
        var host: String
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

    /// Lowercased host(+non-default port), ignoring scheme since http/https share recipient.
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

struct ConsentRequest: Identifiable, Equatable {
    enum Action: Equatable {
        case send(text: String, attachments: [Attachment])
        case retry(UUID)
        /// Allowing grants host and retries transcription; declining keeps audio queued.
        case transcribe(recordingID: UUID)
    }

    let id = UUID()
    var host: String
    var providerName: String
    var connectorNames: [String]
    /// Target chat for held send; reply routes here even if selection moved during sheet.
    var conversationID: UUID
    var action: Action
}
