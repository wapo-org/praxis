import SwiftUI
import AgentMCP

/// A connector's tools with per-tool on/off switches (the detail
/// screen's tools section). Off tools are left out of new
/// conversations; chats that froze them refuse their calls. Tools the
/// server added since the user last looked get a "New" badge once.
struct ConnectorToolToggles: View {
    let library: ConnectorLibrary
    let serverID: String
    let tools: [MCPToolDefinition]
    @Environment(ChatStore.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                SettingsSectionTitle(title)
                Spacer()
                if !tools.isEmpty {
                    Button("Enable all") {
                        store.haptics.fire(.selection)
                        library.setAllToolsEnabled(serverID, on: true)
                    }
                    .buttonStyle(.praxisText)
                    .accessibilityLabel("Enable all tools")
                    Button("Disable all") {
                        store.haptics.fire(.selection)
                        library.setAllToolsEnabled(serverID, on: false)
                    }
                    .buttonStyle(.praxisText)
                    .accessibilityLabel("Disable all tools")
                }
            }
            SettingsCard {
                if tools.isEmpty {
                    Text("This server lists no tools.")
                        .font(Type.inter(14, .subheadline)).foregroundStyle(Praxis.mutedInk)
                        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                }
                ForEach(Array(tools.enumerated()), id: \.element.name) { index, tool in
                    if index > 0 { SettingsDivider() }
                    row(tool)
                }
            }
            Text("Off tools are left out of new chats. Chats that already use them refuse their calls.")
                .font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk).padding(.horizontal, 4)
                .fixedSize(horizontal: false, vertical: true)
        }
        .onDisappear { library.markToolsSeen(serverID) }
    }

    private var title: String {
        let off = tools.filter { !library.isToolEnabled(serverID, tool: $0.name) }.count
        if off == 0 { return tools.count == 1 ? "1 tool" : "\(tools.count) tools" }
        return "\(tools.count - off) of \(tools.count) on"
    }

    private func row(_ tool: MCPToolDefinition) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(tool.displayTitle).font(Type.inter(15, weight: .medium, .body)).foregroundStyle(Praxis.ink)
                    if library.isToolNew(serverID, tool: tool.name) {
                        Text("New")
                            .font(Type.inter(11, weight: .semibold, .caption2))
                            .foregroundStyle(Praxis.canvas)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Praxis.ink, in: Capsule())
                            .accessibilityLabel("New tool")
                    }
                    Spacer(minLength: 4)
                    Text(tool.trustHint).font(Type.inter(11, weight: .medium, .caption2)).foregroundStyle(Praxis.mutedInk)
                }
                if tool.displayTitle != tool.name {
                    Text(tool.name).font(Type.mono(11, .caption2)).foregroundStyle(Praxis.mutedInk)
                }
                if !tool.description.isEmpty {
                    Text(tool.description.firstLine).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.secondaryInk)
                        .lineLimit(1)
                }
            }
            Toggle(isOn: Binding(get: { library.isToolEnabled(serverID, tool: tool.name) }, set: { on in
                store.haptics.fire(.selection)
                library.setToolEnabled(serverID, tool: tool.name, on: on)
            })) {
                Text(tool.displayTitle)
            }
            .labelsHidden()
            .tint(Praxis.ink)
            .accessibilityLabel(tool.displayTitle)
            .accessibilityIdentifier("toolToggle.\(tool.name)")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}

extension MCPToolDefinition {
    /// The server's own claim about a tool — believed only once the
    /// server is trusted (`TrustExplanation`).
    var trustHint: String {
        let traits = annotations.traits
        if traits.contains(.readOnly) { return "Says read-only" }
        if traits.contains(.destructive) { return "Can change things" }
        return "Says safe"
    }
}

private extension String {
    /// The description's first line: tool lists stay one row per tool.
    var firstLine: String {
        self[...].split(separator: "\n", maxSplits: 1).first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? self
    }
}
