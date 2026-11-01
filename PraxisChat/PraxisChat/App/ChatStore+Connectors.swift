import Foundation
import AgentCore
import AgentMCP

/// Connector actions the chat offers: signing in from a refused step,
/// connector prompts in the tray, and "updated in new chats" notes.
extension ChatStore {
    // MARK: Sign in from a chat step

    /// "Sign in to <server>": signs in on the spot when no form is needed
    /// (the server registers apps itself, or a client ID is configured);
    /// otherwise opens the connector's settings, which walk through it.
    /// The conversation keeps its frozen tools: the next call simply
    /// carries the new token.
    func signInToConnector(_ id: String) {
        guard let library = services?.connectors, library.server(id) != nil else { return }
        guard library.canSignInDirectly(id) else {
            openConnectorSettings(id)
            return
        }
        Task { @MainActor in
            do {
                try await library.signInDirectly(id)
                haptics.fire(.success)
            } catch is CancellationError {
                haptics.fire(.warning)
            } catch {
                haptics.fire(.warning)
                openConnectorSettings(id) // shows what went wrong, and the form if one is needed
            }
        }
    }

    func openConnectorSettings(_ id: String) {
        settingsPage = .connector(id)
        isSettingsPresented = true
    }

    // MARK: Prompts

    /// Prompts of the connectors on in this chat, by server.
    var connectorPrompts: [(serverID: String, serverName: String, prompts: [MCPPrompt])] {
        guard isLive, let library = services?.connectors else { return [] }
        return trayConnectors.filter(\.isOn).compactMap { connector in
            guard let prompts = library.prompts[connector.id], !prompts.isEmpty else { return nil }
            return (connector.id, connector.name, prompts)
        }
    }

    func refreshConnectorPrompts() async {
        guard isLive, let library = services?.connectors else { return }
        await library.refreshPrompts(for: trayConnectors.filter(\.isOn).map(\.id))
    }

    /// Fetches a prompt and puts its messages in the composer (the user
    /// reviews and sends it).
    func insertConnectorPrompt(serverID: String, name: String, arguments: [String: String]) async throws {
        guard let library = services?.connectors else { return }
        let result = try await library.prompt(serverID, name: name, arguments: arguments)
        let text = result.composerText
        guard !text.isEmpty else {
            throw MCPError.protocolViolation("the prompt had no text")
        }
        draft = draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? text : draft + "\n\n" + text
    }

    // MARK: Tool list changes

    /// For a chat that froze its tools: the connector's tools changed
    /// since, so new chats get a different list than this one has.
    func connectorUpdateNote(_ id: String) -> String? {
        guard connectorsFrozen, let library = services?.connectors, let live = library.tools[id],
              let frozen = selected?.setup?.mcpServers.first(where: { $0.id == id }) else { return nil }
        let frozenTools = Set(frozen.tools.map(\.name))
        let liveTools = Set(live.map(\.name))
        guard frozenTools != liveTools || library.toolsChangedAt[id].map({ $0 > (selected?.setup?.createdAt ?? .distantFuture) }) == true
        else { return nil }
        return "Tools changed · new chats get the update"
    }
}
