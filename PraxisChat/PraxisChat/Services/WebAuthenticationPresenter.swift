import AuthenticationServices
import UIKit
import AgentMCP

/// Uses ephemeral ASWebAuthenticationSession; http loopback redirects cancel via the auth task.
struct WebAuthenticationPresenter: OAuthPresenter {
    func authorize(url: URL, callbackScheme: String) async throws -> URL {
        let session = await MainActor.run { AuthSession() }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                Task { @MainActor in session.start(url: url, scheme: callbackScheme, continuation: continuation) }
            }
        } onCancel: {
            Task { @MainActor in session.cancel() }
        }
    }
}

@MainActor
private final class AuthSession: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    private var continuation: CheckedContinuation<URL, Error>?
    private var cancelled = false
    private var anchor: UIWindow?

    /// Dummy scheme required to start ASWebAuthenticationSession; http redirects hit local listener.
    private static let loopbackPlaceholder = "praxischat-loopback"

    func start(url: URL, scheme: String, continuation: CheckedContinuation<URL, Error>) {
        guard !cancelled else { return continuation.resume(throwing: CancellationError()) }
        self.continuation = continuation
        guard let window = Self.window() else {
            return finish(nil, ASWebAuthenticationSessionError(.presentationContextNotProvided))
        }
        anchor = window
        let callbackScheme = scheme.lowercased() == "http" || scheme.lowercased() == "https" ? Self.loopbackPlaceholder : scheme
        let session = ASWebAuthenticationSession(url: url, callback: .customScheme(callbackScheme)) { [weak self] url, error in
            MainActor.assumeIsolated { self?.finish(url, error) }
        }
        session.prefersEphemeralWebBrowserSession = true
        session.presentationContextProvider = self
        self.session = session
        if !session.start() {
            finish(nil, ASWebAuthenticationSessionError(.presentationContextInvalid))
        }
    }

    func cancel() {
        cancelled = true
        session?.cancel()
        finish(nil, CancellationError())
    }

    private func finish(_ url: URL?, _ error: Error?) {
        guard let continuation else { return }
        self.continuation = nil
        session = nil
        anchor = nil
        if let url { continuation.resume(returning: url) } else { continuation.resume(throwing: error ?? CancellationError()) }
    }

    /// Anchor is set before session start and only queried while presenting.
    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated { anchor ?? Self.window()! }
    }

    private static func window() -> UIWindow? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.first?.windows.first
    }
}
