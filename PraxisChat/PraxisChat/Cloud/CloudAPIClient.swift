import Foundation

struct CloudServerConfiguration: Sendable, Equatable {
    let baseURL: URL
    let origin: String

    init(baseURL: URL) throws {
        guard var parts = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              let scheme = parts.scheme?.lowercased(), let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/" else { throw CloudAPIError.invalidServer }
        var allowed = scheme == "https"
        #if DEBUG
        allowed = allowed || (scheme == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host))
        #endif
        guard allowed else { throw CloudAPIError.invalidServer }
        parts.scheme = scheme; parts.host = host; parts.path = ""
        if parts.port == (scheme == "https" ? 443 : 80) { parts.port = nil }
        guard let normalized = parts.url else { throw CloudAPIError.invalidServer }
        self.baseURL = normalized
        self.origin = normalized.absoluteString
    }

    static func forLaunch(defaults: UserDefaults = .standard, bundle: Bundle = .main) throws -> Self {
        // A release build supplies PraxisCloudServerURL through Info.plist/build
        // configuration. The reserved .invalid fallback fails closed until set.
        var raw = bundle.object(forInfoDictionaryKey: "PraxisCloudServerURL") as? String ?? "https://cloud.praxis.invalid"
        #if DEBUG
        if let override = defaults.string(forKey: "PraxisCloudServerURL"), !override.isEmpty { raw = override }
        #endif
        guard let url = URL(string: raw) else { throw CloudAPIError.invalidServer }
        return try Self(baseURL: url)
    }
}

struct CloudServerError: Decodable, Sendable {
    let code: String
    let message: String
    let requestId: String?
}

enum CloudAPIError: Error, LocalizedError, Sendable {
    case invalidServer, invalidPath, invalidResponse, invalidContentType
    case http(status: Int, error: CloudServerError?)
    case malformedEvent(String)
    case reconnectLimit

    var statusCode: Int? { if case .http(let status, _) = self { status } else { nil } }
    var code: String? { if case .http(_, let error) = self { error?.code } else { nil } }
    var errorDescription: String? {
        switch self {
        case .invalidServer: "Set a valid HTTPS cloud server address."
        case .invalidPath: "The cloud request has an invalid path."
        case .invalidResponse: "The cloud server returned an invalid response."
        case .invalidContentType: "The cloud server returned an unexpected content type."
        case .http(let status, let error): error?.message ?? "Cloud request failed (\(status))."
        case .malformedEvent(let message): "Invalid cloud event: \(message)"
        case .reconnectLimit: "Couldn't reconnect to the cloud run. Reopen the chat to resume."
        }
    }
}

/// Stateless and injectable; services, uploads and SSE all share this session.
struct CloudAPIClient: Sendable {
    let configuration: CloudServerConfiguration
    let session: URLSession
    let tokens: CloudSessionStore

    init(configuration: CloudServerConfiguration, session: URLSession = .shared,
         tokens: CloudSessionStore = CloudSessionStore()) {
        self.configuration = configuration; self.session = session; self.tokens = tokens
    }

    func send<Response: Decodable & Sendable>(_ path: String, method: String = "GET", body: Data? = nil,
                                             contentType: String = "application/json") async throws -> Response {
        let request = try await request(path, method: method, body: body, contentType: contentType)
        let (data, response) = try await session.data(for: request, delegate: CloudRedirectGuard())
        try Self.validate(response, data: data)
        guard (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type")?.lowercased().contains("application/json") == true else {
            throw CloudAPIError.invalidContentType
        }
        return try JSONDecoder().decode(Response.self, from: data)
    }

    func sendVoid(_ path: String, method: String = "GET", body: Data? = nil,
                  contentType: String = "application/json") async throws {
        let request = try await request(path, method: method, body: body, contentType: contentType)
        let (data, response) = try await session.data(for: request, delegate: CloudRedirectGuard())
        try Self.validate(response, data: data)
    }

    func request(_ path: String, method: String = "GET", body: Data? = nil,
                 contentType: String = "application/json") async throws -> URLRequest {
        guard path.hasPrefix("/"), !path.hasPrefix("//"),
              let url = URL(string: path, relativeTo: configuration.baseURL)?.absoluteURL,
              let origin = try? CloudServerConfiguration(baseURL: URL(string: "/", relativeTo: url)!.absoluteURL),
              origin.origin == configuration.origin else { throw CloudAPIError.invalidPath }
        var request = URLRequest(url: url)
        request.httpMethod = method; request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        if let token = try await tokens.token(for: configuration.origin) {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    static func validate(_ response: URLResponse, data: Data = Data()) throws {
        guard let http = response as? HTTPURLResponse else { throw CloudAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw CloudAPIError.http(status: http.statusCode, error: try? JSONDecoder().decode(CloudServerError.self, from: data))
        }
    }

    func signIn(email: String, password: String) async throws -> CloudSession {
        try await authenticate("/v1/auth/sign-in", email: email, password: password, name: nil)
    }
    func signUp(email: String, password: String, name: String?) async throws -> CloudSession {
        try await authenticate("/v1/auth/sign-up", email: email, password: password, name: name)
    }
    private func authenticate(_ path: String, email: String, password: String, name: String?) async throws -> CloudSession {
        let value: CloudSession = try await send(path, method: "POST", body: JSONEncoder().encode(CloudAuthInput(email: email, password: password, name: name)))
        guard let token = value.bearerToken, !token.isEmpty else { throw CloudSessionError.missingToken }
        try await tokens.setToken(token, for: configuration.origin)
        return value
    }
    func currentSession() async throws -> CloudSession { try await send("/v1/auth/session") }
    func signOut() async throws {
        // Revoke before dropping the credential, so a transient failure can be retried.
        try await sendVoid("/v1/auth/sign-out", method: "POST")
        try await tokens.setToken(nil, for: configuration.origin)
    }

    static func segment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
    }
}

/// Never forward a bearer credential or an upload body through a redirect.
final class CloudRedirectGuard: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
