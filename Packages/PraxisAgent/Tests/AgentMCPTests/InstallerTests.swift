import Foundation
import Testing
import AgentCore
import AgentTestSupport
@testable import AgentMCP

@Suite struct InstallerTests {
    @Test func claudeDesktopConfigKeepsRemotesAndRejectsProcesses() throws {
        let result = try MCPInstaller.parse(config: """
        {
          "mcpServers": {
            "filesystem": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me"]},
            "linear": {"command": "npx", "args": ["-y", "mcp-remote", "https://mcp.linear.app/sse"]},
            "notes": {"type": "http", "url": "https://api.notes.test/mcp", "headers": {"Authorization": "Bearer ${NOTES_TOKEN}", "X-Team": "core"}},
            "legacy": {"type": "sse", "url": "https://old.test/sse"},
            "socket": {"type": "ws", "url": "wss://ws.test/mcp"},
            "python": {"type": "stdio", "command": "uvx", "args": ["mcp-server-git"]},
            "plain": {"url": "http://example.test/mcp"}
          }
        }
        """)
        let rejected = Dictionary(uniqueKeysWithValues: result.rejected.map { ($0.name, $0.reason) })
        #expect(rejected["filesystem"] == "runs a local process — not supported on iPhone")
        #expect(rejected["python"] == MCPInstaller.localProcessReason)
        #expect(rejected["socket"]?.contains("ws") == true)
        #expect(rejected["plain"]?.contains("https") == true)

        let byName = Dictionary(uniqueKeysWithValues: result.candidates.map { ($0.name, $0) })
        #expect(Set(byName.keys) == ["linear", "notes", "legacy"])
        #expect(byName["linear"]?.url?.absoluteString == "https://mcp.linear.app/sse")
        #expect(byName["linear"]?.note == "mcp-remote")
        #expect(byName["legacy"]?.transportHint == .legacySSE)

        let notes = try #require(byName["notes"])
        #expect(notes.inputs.map(\.key) == ["NOTES_TOKEN"])
        #expect(notes.inputs.first?.isSecret == true)
        #expect(notes.inputs.first?.location == .header("Authorization"))

        let secrets = InMemorySecretStore()
        #expect(throws: MCPInstallError.missingInputs(["NOTES_TOKEN"])) { try notes.makeConfig(secrets: secrets) }
        let config = try notes.makeConfig(id: "n1", values: ["NOTES_TOKEN": "tok-123"], secrets: secrets)
        #expect(config.auth == .headers)
        #expect(config.url.absoluteString == "https://api.notes.test/mcp")
        let auth = try #require(config.headers.first { $0.name == "Authorization" })
        guard case .secret(let key) = auth.value else { Issue.record("token must be stored as a secret"); return }
        #expect(try secrets.secret(for: key) == "Bearer tok-123")
        #expect(config.headers.first { $0.name == "X-Team" }?.value == .plain("core"))
        // Nothing secret in the persisted config.
        let encoded = String(decoding: try JSONEncoder().encode(config), as: UTF8.self)
        #expect(!encoded.contains("tok-123"))
    }

    @Test func vsCodeFormatsAndSingleEntries() throws {
        let vscode = try MCPInstaller.parse(config: #"{"servers": {"github": {"type": "http", "url": "https://api.githubcopilot.com/mcp/"}, "local": {"type": "stdio", "command": "node", "args": ["x.js"]}}}"#)
        #expect(vscode.candidates.map(\.name) == ["github"])
        #expect(vscode.rejected.map(\.name) == ["local"])

        let settings = try MCPInstaller.parse(config: #"{"mcp": {"servers": {"a": {"url": "https://a.test/mcp"}}}}"#)
        #expect(settings.candidates.map(\.urlTemplate) == ["https://a.test/mcp"])

        let bare = try MCPInstaller.parse(config: #"{"url": "https://mcp.stripe.com"}"#)
        #expect(bare.candidates.first?.name == "Stripe")

        let bareCommand = try MCPInstaller.parse(config: #"{"command": "docker", "args": ["run", "x"]}"#)
        #expect(bareCommand.candidates.isEmpty)
        #expect(bareCommand.rejected.first?.reason == MCPInstaller.localProcessReason)

        let packagesOnly = try MCPInstaller.parse(config: #"{"name": "io.github.x/y", "packages": [{"registryType": "npm", "identifier": "y"}]}"#)
        #expect(packagesOnly.candidates.isEmpty)
        #expect(packagesOnly.rejected.first?.reason == MCPInstaller.localProcessReason)

        #expect(throws: MCPInstallError.self) { try MCPInstaller.parse(config: "not json") }
    }

    @Test func singleURLWithVariables() throws {
        let candidate = try MCPInstaller.parse(url: "  https://{tenant}.mcp.example.com/mcp  ")
        #expect(candidate.inputs.map(\.key) == ["tenant"])
        #expect(candidate.url == nil)
        #expect(throws: MCPInstallError.missingInputs(["tenant"])) { try candidate.makeConfig(secrets: InMemorySecretStore()) }
        let config = try candidate.makeConfig(values: ["tenant": "acme"], secrets: InMemorySecretStore())
        #expect(config.url.absoluteString == "https://acme.mcp.example.com/mcp")
        #expect(config.auth == MCPAuthKind.none)

        #expect(try MCPInstaller.parse(url: "https://mcp.linear.app/mcp").name == "Linear")
        #expect(try MCPInstaller.parse(url: "http://localhost:8080/mcp").url != nil)
        #expect(throws: MCPInstallError.unsupportedScheme("http")) { try MCPInstaller.parse(url: "http://example.com/mcp") }
        #expect(throws: MCPInstallError.self) { try MCPInstaller.parse(url: "not a url") }
    }
}

@Suite struct RegistryTests {
    static let page = """
    {"servers": [
      {"server": {"name": "ai.smithery/github", "description": "GitHub", "version": "1.0.0",
                  "remotes": [{"type": "streamable-http", "url": "https://server.smithery.ai/github/mcp",
                               "headers": [{"name": "Authorization", "value": "Bearer {smithery_api_key}", "isSecret": true, "isRequired": true}]}]},
       "_meta": {"io.modelcontextprotocol.registry/official": {"status": "active", "isLatest": true}}},
      {"server": {"name": "io.github.acme/weather", "title": "Weather", "description": "Forecasts",
                  "remotes": [{"type": "sse", "url": "https://{region}.weather.test/sse",
                               "variables": {"region": {"description": "Region", "default": "eu", "choices": ["eu", "us"]}}},
                              {"type": "websocket", "url": "wss://weather.test"}],
                  "packages": [{"registryType": "npm", "identifier": "weather-mcp"}]}},
      {"server": {"name": "io.github.acme/local-only", "description": "Files",
                  "packages": [{"registryType": "npm", "identifier": "files-mcp"}]}},
      {"server": {"name": "io.github.acme/gone", "remotes": [{"type": "streamable-http", "url": "https://gone.test/mcp"}]},
       "_meta": {"io.modelcontextprotocol.registry/official": {"status": "deleted"}}},
      {"server": {"name": "io.github.acme/keyed", "remotes": [{"type": "streamable-http", "url": "https://keyed.test/mcp",
                  "headers": [{"name": "X-API-Key", "description": "Your key", "isSecret": true, "isRequired": true}]}]}}
    ], "metadata": {"nextCursor": "io.github.acme/keyed:1.0.0", "count": 5}}
    """

    @Test func listsOnlyRemoteServers() async throws {
        let transport = ScriptedTransport(replies: [.json(Self.page)])
        let registry = MCPRegistryClient(transport: transport)
        let page = try await registry.list(search: "git hub", cursor: "abc:1", limit: 20)

        #expect(page.entries.map(\.name) == ["ai.smithery/github", "io.github.acme/weather", "io.github.acme/keyed"])
        #expect(page.nextCursor == "io.github.acme/keyed:1.0.0")
        let url = try #require(transport.requests.first?.url)
        let query = Dictionary(uniqueKeysWithValues: (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        #expect(url.host() == "registry.modelcontextprotocol.io")
        #expect(url.path() == "/v0.1/servers")
        #expect(query == ["search": "git hub", "cursor": "abc:1", "limit": "20", "version": "latest"])

        let github = page.entries[0]
        #expect(github.displayName == "github")
        #expect(github.remotes[0].inputs.map(\.key) == ["smithery_api_key"])
        #expect(github.remotes[0].inputs[0].isSecret)

        let weather = page.entries[1]
        #expect(weather.displayName == "Weather")
        #expect(weather.remotes.count == 1) // websocket dropped
        #expect(weather.remotes[0].transportHint == .legacySSE)
        #expect(weather.remotes[0].inputs.first?.choices == ["eu", "us"])
        let weatherConfig = try weather.candidate(for: weather.remotes[0]).makeConfig(secrets: InMemorySecretStore())
        #expect(weatherConfig.url.absoluteString == "https://eu.weather.test/sse") // default used
        #expect(weatherConfig.transportHint == .legacySSE)

        let keyed = page.entries[2]
        let secrets = InMemorySecretStore()
        #expect(keyed.remotes[0].inputs.map(\.key) == ["X-API-Key"])
        let keyedConfig = try keyed.candidate(for: keyed.remotes[0]).makeConfig(id: "k", values: ["X-API-Key": "sk-1"], secrets: secrets)
        #expect(keyedConfig.headers.map(\.name) == ["X-API-Key"])
        #expect(secrets.allKeys.count == 1)
        #expect(try secrets.secret(for: secrets.allKeys[0]) == "sk-1")
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["PRAXIS_LIVE_MCP"] == "1"))
    func liveRegistrySmoke() async throws {
        let page = try await MCPRegistryClient().list(search: "github", limit: 10)
        #expect(page.entries.allSatisfy { !$0.remotes.isEmpty })
    }
}
