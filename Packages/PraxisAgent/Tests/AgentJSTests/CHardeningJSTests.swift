import Foundation
import Testing
import AgentCore
@testable import AgentJS

/// Regression tests for Team C hardening fixes (C0 fetch timeout).
@Suite struct CHardeningFetchTimeoutTests {
    struct HungTransport: HTTPTransport, Sendable {
        func stream(_ request: URLRequest) async throws -> HTTPStreamResponse {
            let body = AsyncThrowingStream<Data, Error> { _ in
                // Never yields, never finishes, ignores cancellation.
            }
            return HTTPStreamResponse(head: HTTPResponseHead(status: 200, headers: [:]), body: body)
        }
    }

    @Test func timeoutAbandonsAHungTransfer() async throws {
        let request = try FetchRequest(meta: #"{"url":"https://example.com/slow"}"#, body: nil,
                                       mode: .build, allowPrivateNetwork: true)
        let start = Date()
        let result = await request.perform(transport: HungTransport(), maxBytes: 1 << 20,
                                           timeout: .milliseconds(100)) { _ in }
        #expect(Date().timeIntervalSince(start) < 10)
        guard case .failure(let failure) = result else {
            Issue.record("expected a timeout failure, got \(result)")
            return
        }
        #expect(failure.name == "TimeoutError")
    }
}

@Suite struct CHardeningIsPrivateTests {
    @Test func nonCanonicalLiteralsAreJudgedByTheirAddress() {
        // 127.0.0.1 in decimal, hex, octal and short forms.
        for host in ["127.0.0.1", "2130706433", "0x7f.0.0.1", "0x7f000001", "0177.0.0.1", "127.1", "127.0.1"] {
            #expect(FetchRequest.isPrivate(host: host), "expected private: \(host)")
        }
        // 192.168.1.1 in decimal and short forms.
        for host in ["192.168.1.1", "3232235777", "192.168.257", "0xc0.0xa8.0x1.0x1"] {
            #expect(FetchRequest.isPrivate(host: host), "expected private: \(host)")
        }
        // IPv6 loopback / link-local / ULA / mapped, canonical and not.
        for host in ["::1", "[::1]", "0:0:0:0:0:0:0:1", "fe80::1", "FE80::abcd", "fc00::1", "fd12:3456::1",
                     "::ffff:127.0.0.1", "::ffff:7f00:1", "fec0::1", "fe80::1%en0"] {
            #expect(FetchRequest.isPrivate(host: host), "expected private: \(host)")
        }
        // Names and public literals stay public.
        for host in ["example.com", "8.8.8.8", "1.1.1.1", "93.184.216.34", "2001:4860:4860::8888",
                     "::ffff:8.8.8.8", "9.9.9.9", "localhost.example.com"] {
            #expect(!FetchRequest.isPrivate(host: host), "expected public: \(host)")
        }
        // Local names (and FQDN-root form) stay blocked.
        for host in ["localhost", "LOCALHOST", "a.localhost", "printer.local", "localhost."] {
            #expect(FetchRequest.isPrivate(host: host), "expected private: \(host)")
        }
    }

    @Test func requestInitRejectsBypassLiterals() {
        for raw in ["http://2130706433/", "http://0x7f.0.0.1/", "http://0177.0.0.1/", "http://127.1/",
                    "http://[0:0:0:0:0:0:0:1]/", "http://[::ffff:7f00:1]/", "http://3232235777/admin"] {
            #expect(throws: HostFailure.self) {
                _ = try FetchRequest(meta: #"{"url":"\#(raw)"}"#, body: nil, mode: .build, allowPrivateNetwork: false)
            }
        }
        #expect(!FetchRequest.allowsRedirect(to: URL(string: "http://2130706433/x")!))
        #expect(FetchRequest.allowsRedirect(to: URL(string: "https://example.com/x")!))
    }

    @Test func oversizedBodyIsRejected() {
        let big = Data(count: FetchRequest.defaultMaxBodyBytes + 1)
        #expect(throws: HostFailure.self) {
            _ = try FetchRequest(meta: #"{"url":"https://example.com/upload","method":"POST"}"#, body: big,
                                 mode: .build, allowPrivateNetwork: true)
        }
        #expect(throws: Never.self) {
            _ = try FetchRequest(meta: #"{"url":"https://example.com/upload","method":"POST"}"#,
                                 body: Data(count: 1024), mode: .build, allowPrivateNetwork: true)
        }
    }
}

@Suite struct CHardeningProtoTests {
    @Test func protoToolNamesCannotSwapPrototypes() async {
        let specs = [
            ToolSpec(name: "__proto__", description: "evil", inputSchema: ["type": "object"]),
            ToolSpec(name: "mcp__s__ok", description: "fine", inputSchema: ["type": "object"]),
            ToolSpec(name: "mcp____proto____polluted", description: "evil", inputSchema: ["type": "object"]),
            ToolSpec(name: "mcp__s____proto__", description: "evil", inputSchema: ["type": "object"]),
        ]
        let r = await QuickJSRunner().run("""
            const protoIntact = Object.getPrototypeOf(tools) === Object.prototype
                && Object.getPrototypeOf(tools.s) === Object.prototype;
            return {
                protoIntact,
                directOk: typeof tools.mcp__s__ok,
                namespacedOk: typeof tools.s.ok,
                evilNs: typeof tools.__proto__.polluted,
                hasOwnProto: Object.prototype.hasOwnProperty.call(tools, '__proto__'),
            };
            """, context: makeContext(), hostTools: specs)
        #expect(r.error == nil)
        #expect(r.value == ["protoIntact": true, "directOk": "function", "namespacedOk": "function",
                            "evilNs": "undefined", "hasOwnProto": false])
    }
}
