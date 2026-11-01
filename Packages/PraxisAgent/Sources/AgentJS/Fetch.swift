import Darwin
import Foundation
import Synchronization
import AgentCore

/// A continuation shared across tasks. Sound only because every holder
/// resumes through `FirstWins`, which lets exactly one result through.
private struct UncheckedSendable<T>: @unchecked Sendable {
    let value: T
}

/// Resumes its continuation with the first result only; later results are
/// dropped. Shared across the worker and the timer task.
private final class FirstWins<T: Sendable>: Sendable {
    private let cont: UncheckedSendable<CheckedContinuation<T, Error>>
    private let done = Mutex(false)

    init(_ continuation: CheckedContinuation<T, Error>) {
        self.cont = UncheckedSendable(value: continuation)
    }

    func finish(_ result: Result<T, Error>) {
        let first = done.withLock { d in if d { return false }; d = true; return true }
        if first { cont.value.resume(with: result) }
    }
}

/// One validated `fetch` request. Validation happens synchronously on the
/// engine thread (so policy errors throw at the call site); the transfer
/// runs in a task and reports back as a `HostResult`.
struct FetchRequest: Sendable {
    var url: URL
    var method: String
    var headers: [[String]]
    var body: Data?

    private static let forbiddenMethods: Set<String> = ["CONNECT", "TRACE", "TRACK"]

    /// Largest request body, matching the default response cap: the body is
    /// retained (and copied) for the whole transfer, so it can't be open-ended.
    static let defaultMaxBodyBytes = 10 << 20

    init(meta: String, body: Data?, mode: AgentMode, allowPrivateNetwork: Bool,
         maxBodyBytes: Int = FetchRequest.defaultMaxBodyBytes) throws {
        guard let json = try? JSONValue(parsing: meta), let rawURL = json["url"]?.stringValue else {
            throw HostFailure(.type, "fetch: invalid request")
        }
        if let body, body.count > maxBodyBytes {
            throw HostFailure(.range, name: "RangeError", "fetch: request body is over the \(maxBodyBytes / (1 << 20)) MB cap")
        }
        guard let url = URL(string: rawURL), let scheme = url.scheme?.lowercased() else {
            throw HostFailure(.type, "fetch: invalid URL \(rawURL.prefix(200)) (use an absolute http:// or https:// URL)")
        }
        guard scheme == "http" || scheme == "https" else {
            throw HostFailure(.type, "fetch: only http and https URLs are supported (got \(scheme):)")
        }
        guard let host = url.host(percentEncoded: false), !host.isEmpty else {
            throw HostFailure(.type, "fetch: invalid URL \(rawURL.prefix(200))")
        }
        if !allowPrivateNetwork, Self.isPrivate(host: host) {
            throw HostFailure(.type, "fetch: requests to localhost or private network addresses aren't allowed")
        }
        let method = (json["method"]?.stringValue ?? "GET").uppercased()
        guard !method.isEmpty, method.allSatisfy({ $0.isLetter || $0 == "-" || $0 == "_" }), !Self.forbiddenMethods.contains(method) else {
            throw HostFailure(.type, "fetch: unsupported method \(method)")
        }
        if mode == .plan, method != "GET", method != "HEAD" {
            throw HostFailure(.type, "fetch: Plan mode only allows GET and HEAD requests (got \(method)). Propose the change instead of making it.")
        }
        self.url = url
        self.method = method
        self.headers = (json["headers"]?.arrayValue ?? []).compactMap { pair in
            guard let k = pair[0]?.stringValue, let v = pair[1]?.stringValue else { return nil }
            return [k, v]
        }
        self.body = body
    }

    /// Loopback, link-local, private (RFC 1918 / ULA) and `.local` hosts.
    /// Redirect check for the fetch transport: http(s) to a public host only.
    static func allowsRedirect(to url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host(percentEncoded: false), !host.isEmpty else { return false }
        return !isPrivate(host: host)
    }

    /// Literal addresses only — a public name that resolves to a private
    /// address isn't caught here. Parsed with the same functions as the
    /// resolver (`inet_aton` for IPv4, `inet_pton` for IPv6), so non-canonical
    /// literals (`2130706433`, `0x7f.1`, `0177.0.0.1`, `127.1`, full-form
    /// IPv6, `::ffff:7f00:1`) are judged by the address they actually reach.
    static func isPrivate(host raw: String) -> Bool {
        var host = raw.lowercased()
        if host.hasPrefix("["), host.hasSuffix("]"), host.count >= 2 { host = String(host.dropFirst().dropLast()) }
        if let zone = host.firstIndex(of: "%") { host = String(host[..<zone]) } // fe80::1%en0
        while host.hasSuffix(".") { host.removeLast() } // FQDN root
        if host == "localhost" || host.hasSuffix(".localhost") || host.hasSuffix(".local") { return true }
        var v4 = in_addr()
        if host.withCString({ inet_aton($0, &v4) }) != 0 {
            return Self.isPrivateIPv4(UInt32(bigEndian: v4.s_addr))
        }
        var v6 = in6_addr()
        if host.withCString({ inet_pton(AF_INET6, $0, &v6) }) == 1 {
            return withUnsafeBytes(of: v6) { Self.isPrivateIPv6($0) }
        }
        return false
    }

    /// Host-order IPv4: loopback, RFC 1918, link-local, CG-NAT and 0/8.
    private static func isPrivateIPv4(_ ip: UInt32) -> Bool {
        let b0 = ip >> 24, b1 = (ip >> 16) & 0xFF
        switch (b0, b1) {
        case (0, _), (10, _), (127, _): return true
        case (169, 254), (192, 168): return true
        case (172, 16...31): return true
        case (100, 64...127): return true // carrier-grade NAT
        default: return false
        }
    }

    /// 16 raw bytes: loopback, unspecified, link-local, ULA, deprecated
    /// site-local and IPv4-mapped (judged by the embedded address).
    private static func isPrivateIPv6(_ bytes: UnsafeRawBufferPointer) -> Bool {
        guard bytes.count == 16 else { return false }
        let b = (0..<16).map { bytes[$0] }
        if b.allSatisfy({ $0 == 0 }) { return true } // ::
        if b.prefix(15).allSatisfy({ $0 == 0 }), b[15] == 1 { return true } // ::1
        if b[0] == 0xFE, (b[1] & 0xC0) == 0x80 { return true } // fe80::/10 link-local
        if (b[0] & 0xFE) == 0xFC { return true } // fc00::/7 unique-local
        if b[0] == 0xFE, (b[1] & 0xC0) == 0xC0 { return true } // fec0::/10 site-local (deprecated)
        if b.prefix(10).allSatisfy({ $0 == 0 }), b[10] == 0xFF, b[11] == 0xFF {
            let ip = UInt32(b[12]) << 24 | UInt32(b[13]) << 16 | UInt32(b[14]) << 8 | UInt32(b[15])
            return isPrivateIPv4(ip)
        }
        return false
    }

    private struct TooLarge: Error {}
    private struct TimedOut: Error {}

    func perform(transport: any HTTPTransport, maxBytes: Int, timeout: Duration,
                 emit: @escaping @Sendable (ToolProgress) -> Void) async -> HostResult {
        var request = URLRequest(url: url)
        request.httpMethod = method
        for pair in headers where pair.count == 2 { request.addValue(pair[1], forHTTPHeaderField: pair[0]) }
        request.httpBody = body
        request.httpShouldHandleCookies = false
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = Double(timeout.components.seconds) + 1
        let label = "\(method) \(Self.display(url))"
        let finalRequest = request
        let isHead = method == "HEAD"
        do {
            let (head, data) = try await Self.withTimeout(timeout) {
                let response = try await transport.stream(finalRequest)
                if let length = response.head.header("content-length").flatMap(Int.init), length > maxBytes { throw TooLarge() }
                var data = Data()
                if !isHead {
                    for try await chunk in response.body {
                        data.append(chunk)
                        if data.count > maxBytes { throw TooLarge() }
                    }
                }
                return (response.head, data)
            }
            emit(.trace(.network, "\(label) → \(head.status) · \(Self.size(data.count))"))
            let meta: JSONValue = [
                "status": .number(Double(head.status)),
                "statusText": .string(Self.reason(head.status)),
                "url": .string((head.url ?? url).absoluteString),
                "redirected": .bool(head.url.map { $0 != url } ?? false),
                "headers": .array(head.headers.sorted { $0.key < $1.key }.map { [.string($0.key), .string($0.value)] }),
            ]
            return .response(meta: meta.encodedString(), body: data)
        } catch is TooLarge {
            emit(.trace(.network, "\(label) → too large"))
            return .failure(HostFailure(.type, "fetch: response body exceeds \(maxBytes / (1 << 20)) MB"))
        } catch is TimedOut {
            emit(.trace(.network, "\(label) → timed out"))
            return .failure(HostFailure(.type, name: "TimeoutError", "fetch: no complete response within \(timeout.components.seconds) s"))
        } catch is CancellationError {
            return .failure(HostFailure(name: "AbortError", "fetch: cancelled"))
        } catch {
            let message = (error as? ProviderError)?.description ?? error.localizedDescription
            emit(.trace(.network, "\(label) → failed"))
            return .failure(HostFailure(.type, "fetch failed: \(message)"))
        }
    }

    /// First result wins; the loser is cancelled and abandoned, never
    /// awaited — a throwing group would wait for a hung child here and the
    /// timeout would never fire.
    private static func withTimeout<T: Sendable>(_ limit: Duration, _ work: @escaping @Sendable () async throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            let once = FirstWins(continuation)
            let worker = Task {
                do { once.finish(.success(try await work())) } catch { once.finish(.failure(error)) }
            }
            Task {
                try? await Task.sleep(for: limit)
                once.finish(.failure(TimedOut()))
                worker.cancel()
            }
        }
    }

    /// URL for traces: no fragment, capped length.
    static func display(_ url: URL) -> String {
        var s = url.absoluteString
        if let hash = s.firstIndex(of: "#") { s = String(s[..<hash]) }
        return s.count > 120 ? String(s.prefix(119)) + "…" : s
    }

    static func size(_ bytes: Int) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        if bytes < 1 << 20 { return "\(Int((Double(bytes) / 1024).rounded())) KB" }
        return String(format: "%.1f MB", Double(bytes) / Double(1 << 20))
    }

    /// Reason phrases (HTTP/2 responses carry none; URLSession doesn't expose them).
    static func reason(_ status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 201: return "Created"
        case 202: return "Accepted"
        case 204: return "No Content"
        case 206: return "Partial Content"
        case 301: return "Moved Permanently"
        case 302: return "Found"
        case 303: return "See Other"
        case 304: return "Not Modified"
        case 307: return "Temporary Redirect"
        case 308: return "Permanent Redirect"
        case 400: return "Bad Request"
        case 401: return "Unauthorized"
        case 403: return "Forbidden"
        case 404: return "Not Found"
        case 405: return "Method Not Allowed"
        case 406: return "Not Acceptable"
        case 408: return "Request Timeout"
        case 409: return "Conflict"
        case 410: return "Gone"
        case 413: return "Content Too Large"
        case 415: return "Unsupported Media Type"
        case 422: return "Unprocessable Content"
        case 429: return "Too Many Requests"
        case 500: return "Internal Server Error"
        case 501: return "Not Implemented"
        case 502: return "Bad Gateway"
        case 503: return "Service Unavailable"
        case 504: return "Gateway Timeout"
        default: return ""
        }
    }
}

/// WHATWG-shaped URL components computed with Foundation's RFC 3986
/// parser (backs the JS `URL` class).
struct URLParts {
    var json: String

    private static let defaultPorts: [String: Int] = ["http": 80, "https": 443, "ws": 80, "wss": 443, "ftp": 21]
    private static let special: Set<String> = ["http", "https", "ws", "wss", "ftp", "file"]

    static func parse(_ input: String, base: String?) -> URLParts? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines.union(.controlCharacters))
        var url: URL?
        if let base {
            guard let baseURL = parseAbsolute(base) else { return nil }
            url = URL(string: trimmed, relativeTo: baseURL)?.absoluteURL
        } else {
            url = parseAbsolute(trimmed)
        }
        guard var url, let rawScheme = url.scheme, !rawScheme.isEmpty else { return nil }
        let scheme = rawScheme.lowercased()
        let isSpecial = special.contains(scheme)
        if isSpecial { url = url.standardized }
        guard let c = URLComponents(url: url, resolvingAgainstBaseURL: true) else { return nil }
        var hostname = (c.percentEncodedHost ?? "").lowercased()
        if hostname.contains(":"), !hostname.hasPrefix("[") { hostname = "[\(hostname)]" }
        if isSpecial, scheme != "file", hostname.isEmpty { return nil }
        let port = c.port.flatMap { $0 == defaultPorts[scheme] ? nil : String($0) } ?? ""
        let host = hostname + (port.isEmpty ? "" : ":" + port)
        let hasAuthority = c.percentEncodedHost != nil || scheme == "file"
        var path = c.percentEncodedPath
        if isSpecial, path.isEmpty { path = "/" }
        let search = c.percentEncodedQuery.map { $0.isEmpty ? "" : "?" + $0 } ?? ""
        let hash = c.percentEncodedFragment.map { $0.isEmpty ? "" : "#" + $0 } ?? ""
        let user = c.percentEncodedUser ?? "", password = c.percentEncodedPassword ?? ""
        let auth = user.isEmpty && password.isEmpty ? "" : user + (password.isEmpty ? "" : ":" + password) + "@"
        let href = scheme + ":" + (hasAuthority ? "//" + auth + host : "") + path + search + hash
        let origin = isSpecial && scheme != "file" ? scheme + "://" + host : "null"
        let value: JSONValue = [
            "href": .string(href), "origin": .string(origin), "protocol": .string(scheme + ":"),
            "username": .string(user), "password": .string(password), "host": .string(host),
            "hostname": .string(hostname), "port": .string(port), "pathname": .string(path),
            "search": .string(search), "hash": .string(hash), "hasAuthority": .bool(hasAuthority),
        ]
        return URLParts(json: value.encodedString())
    }

    /// An absolute URL (with a scheme), or nil.
    private static func parseAbsolute(_ s: String) -> URL? {
        guard let url = URL(string: s), let scheme = url.scheme, !scheme.isEmpty,
              s.lowercased().hasPrefix(scheme.lowercased() + ":") else { return nil }
        return url
    }
}
