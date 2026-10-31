import Foundation
import AgentCore
import AgentMCP

extension ChatStore {
    var showsDemoToggles: Bool { !isLive }

    /// The web-search toggle only shows where the provider can search.
    var showsWebSearch: Bool {
        if let cloud = cloudServices { return cloud.model(selectionID: model.id)?.capabilities.serverWebSearch == true }
        return !isLive || services?.isWebSearchAvailable == true
    }

    /// The tray's connector list: demo data, or the installed servers with
    /// this conversation's enablement when live. Once the chat has frozen
    /// its tools, the frozen connectors still toggle (off = refused in
    /// this chat only); servers outside the frozen setup are listed
    /// separately (`newChatOnlyConnectors`).
    var trayConnectors: [Connector] {
        if let cloud = cloudServices {
            let off = selected?.disabledServerIDs ?? []
            let picked = selected?.connectorIDs
            return cloud.connectors.map { $0.adapter(isOn: $0.enabled && !off.contains($0.id) && (picked?.contains($0.id) ?? true)) }
        }
        guard isLive else { return connectors }
        guard let library = services?.connectors else { return [] }
        let conv = selected
        let off = conv?.disabledServerIDs ?? []
        if let conv, let frozen = frozenServerIDs(of: conv) {
            return library.servers.filter { frozen.contains($0.id) }.map { server in
                Connector(id: server.id, name: server.name, monogram: Self.monogram(server.name),
                          isOn: server.enabled && !off.contains(server.id),
                          lockedReason: server.enabled ? nil : "Off in Settings")
            }
        }
        let enabled = Set(conv.map(enabledConnectorIDs(for:)) ?? library.defaultConversationServerIDs)
        return library.servers.map { server in
            Connector(id: server.id, name: server.name, monogram: Self.monogram(server.name),
                      isOn: enabled.contains(server.id) && !off.contains(server.id))
        }
    }

    /// Installed servers the selected chat can't use: added (or not
    /// picked) after it froze its tools. They're available in new chats.
    var newChatOnlyConnectors: [Connector] {
        guard isLive, let library = services?.connectors, let conv = selected,
              let frozen = frozenServerIDs(of: conv) else { return [] }
        return library.servers.filter { !frozen.contains($0.id) }.map { server in
            Connector(id: server.id, name: server.name, monogram: Self.monogram(server.name), isOn: false,
                      lockedReason: "Available in new chats")
        }
    }

    /// True once the selected conversation froze its tools: only those
    /// connectors can be switched on or off here.
    var connectorsFrozen: Bool {
        isLive && selected.flatMap(frozenServerIDs(of:)) != nil
    }

    func setConnector(_ id: String, isOn: Bool) {
        if cloudServices != nil, let conv = selected {
            if isOn { conv.disabledServerIDs.remove(id) } else { conv.disabledServerIDs.insert(id) }
            persistConversation(conv)
            return
        }
        guard isLive else {
            if let i = connectors.firstIndex(where: { $0.id == id }) { connectors[i].isOn = isOn }
            return
        }
        guard let conv = selected else { return }
        if let frozen = frozenServerIDs(of: conv) {
            // Frozen: the tool list can't change, so "off" is a refusal the
            // runtime applies on every run of this chat.
            guard frozen.contains(id) else { return }
            if isOn { conv.disabledServerIDs.remove(id) } else { conv.disabledServerIDs.insert(id) }
        } else {
            var ids = enabledConnectorIDs(for: conv).filter { $0 != id }
            if isOn { ids.append(id) }
            conv.connectorIDs = ids
            conv.disabledServerIDs.remove(id)
        }
        persistConversation(conv)
    }

    private static func monogram(_ name: String) -> String { String(name.prefix(1)).uppercased() }

    /// Connectors to freeze into the conversation's setup.
    func enabledConnectorIDs(for conv: Conversation) -> [String] {
        if let cloud = cloudServices {
            let installed = Set(cloud.connectors.filter(\.enabled).map(\.id))
            return (conv.connectorIDs ?? Array(installed)).filter(installed.contains).sorted()
        }
        let installed = services?.connectors.servers.map(\.id) ?? []
        let ids = conv.connectorIDs ?? services?.connectors.defaultConversationServerIDs ?? []
        return ids.filter(installed.contains)
    }

    /// The frozen servers, once the setup can no longer be re-prepared
    /// (a live message has been sent).
    func frozenServerIDs(of conv: Conversation) -> Set<String>? {
        guard let setup = conv.setup, conv.turns.contains(where: { $0.engine == .live && !$0.transcript.isEmpty }) else { return nil }
        return Set(setup.mcpServers.map(\.id))
    }

}
