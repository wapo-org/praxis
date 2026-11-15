import Foundation
import AgentCore
import AgentMCP

extension ChatStore {
    var showsDemoToggles: Bool { !isLive }

    var showsWebSearch: Bool {
        if let cloud = cloudServices { return cloud.model(selectionID: model.id)?.capabilities.serverWebSearch == true }
        return !isLive || services?.isWebSearchAvailable == true
    }

    /// Once frozen, connectors only toggle per-chat refusals.
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

    var newChatOnlyConnectors: [Connector] {
        guard isLive, let library = services?.connectors, let conv = selected,
              let frozen = frozenServerIDs(of: conv) else { return [] }
        return library.servers.filter { !frozen.contains($0.id) }.map { server in
            Connector(id: server.id, name: server.name, monogram: Self.monogram(server.name), isOn: false,
                      lockedReason: "Available in new chats")
        }
    }

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
            // Frozen tools cannot change; toggling off marks a runtime refusal.
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

    func enabledConnectorIDs(for conv: Conversation) -> [String] {
        if let cloud = cloudServices {
            let installed = Set(cloud.connectors.filter(\.enabled).map(\.id))
            return (conv.connectorIDs ?? Array(installed)).filter(installed.contains).sorted()
        }
        let installed = services?.connectors.servers.map(\.id) ?? []
        let ids = conv.connectorIDs ?? services?.connectors.defaultConversationServerIDs ?? []
        return ids.filter(installed.contains)
    }

    func frozenServerIDs(of conv: Conversation) -> Set<String>? {
        guard let setup = conv.setup, conv.turns.contains(where: { $0.engine == .live && !$0.transcript.isEmpty }) else { return nil }
        return Set(setup.mcpServers.map(\.id))
    }

}
