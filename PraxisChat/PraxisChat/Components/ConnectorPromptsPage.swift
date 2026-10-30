import SwiftUI
import AgentMCP

/// The tray's "Prompts" page: prompts offered by the chat's connectors
/// (MCP `prompts/list`). Picking one fetches it (`prompts/get`, after
/// asking for its arguments) and puts its text in the composer.
struct ConnectorPromptsPage: View {
    @Environment(ChatStore.self) private var store
    var onBack: () -> Void
    /// The prompt is in the composer: close the tray.
    var onInserted: () -> Void

    @State private var picked: Picked?
    @State private var values: [String: String] = [:]
    @State private var busy = false
    @State private var error: String?

    private struct Picked: Equatable {
        var serverID: String
        var serverName: String
        var prompt: MCPPrompt
    }

    var body: some View {
        if let cloud = store.cloudServices {
            CloudCatalogPromptsPage(services: cloud, onBack: onBack, onInserted: onInserted)
        } else {
            // SUNSET(native-loop): MCP client-backed prompt browser.
            nativeBody
        }
    }

    private var nativeBody: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if let picked {
                argumentsForm(picked)
            } else {
                list
            }
            if let error {
                Text(error).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.destructive)
                    .padding(.horizontal, 4)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .task { await store.refreshConnectorPrompts() }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Button {
                if picked != nil {
                    withAnimation(Motion.reflow) { picked = nil; error = nil }
                } else {
                    onBack()
                }
            } label: {
                Image(systemName: "chevron.left")
            }
            .buttonStyle(.praxisIcon(.compact))
            .accessibilityLabel("Back")
            Text(picked?.prompt.displayTitle ?? "Prompts").font(Type.inter(15, weight: .semibold, .body)).foregroundStyle(Praxis.ink)
                .lineLimit(1)
            Spacer()
            if busy { ProgressView().controlSize(.small) }
        }
    }

    @ViewBuilder
    private var list: some View {
        let groups = store.connectorPrompts
        if groups.isEmpty {
            Text("None of this chat's connectors offer prompts.")
                .font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk).padding(.horizontal, 4)
        }
        ForEach(groups, id: \.serverID) { group in
            VStack(alignment: .leading, spacing: 6) {
                Text(group.serverName).font(Type.inter(12, weight: .medium, .caption)).foregroundStyle(Praxis.mutedInk)
                    .padding(.horizontal, 4)
                card {
                    ForEach(Array(group.prompts.enumerated()), id: \.element.name) { index, prompt in
                        if index > 0 { divider }
                        Button { pick(group.serverID, group.serverName, prompt) } label: { row(prompt) }
                            .buttonStyle(PressHighlightStyle())
                            .disabled(busy)
                            .accessibilityLabel("\(group.serverName) prompt: \(prompt.displayTitle)")
                    }
                }
            }
        }
    }

    private func row(_ prompt: MCPPrompt) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "text.bubble").font(.system(size: 14)).foregroundStyle(Praxis.mutedInk).frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(prompt.displayTitle).font(Type.inter(15, .body)).foregroundStyle(Praxis.ink)
                if let description = prompt.description, !description.isEmpty {
                    Text(description).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk).lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
            }
            Spacer()
            if !prompt.arguments.isEmpty {
                LucideIcon(name: "chevron-right", size: 14).foregroundStyle(Praxis.mutedInk)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
    }

    private func argumentsForm(_ picked: Picked) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let description = picked.prompt.description, !description.isEmpty {
                Text(description).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.secondaryInk).padding(.horizontal, 4)
                    .fixedSize(horizontal: false, vertical: true)
            }
            card {
                ForEach(Array(picked.prompt.arguments.enumerated()), id: \.element.name) { index, argument in
                    if index > 0 { divider }
                    VStack(alignment: .leading, spacing: 4) {
                        Text((argument.title ?? argument.name) + (argument.required ? "" : " (optional)"))
                            .font(Type.inter(12, weight: .medium, .caption)).foregroundStyle(Praxis.mutedInk)
                        TextField(argument.description ?? "", text: Binding(
                            get: { values[argument.name] ?? "" },
                            set: { values[argument.name] = $0 }), axis: .vertical)
                            .font(Type.inter(15, .body))
                            .lineLimit(1...4)
                            .accessibilityLabel(argument.title ?? argument.name)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                }
            }
            Button { insert(picked) } label: {
                PraxisButtonLabel("Insert")
            }
            .buttonStyle(.praxisPrimary(fillsWidth: true))
            .disabled(busy || picked.prompt.arguments.contains { $0.required && (values[$0.name] ?? "").trimmingCharacters(in: .whitespaces).isEmpty })
            .accessibilityLabel("Insert prompt")
        }
    }

    // MARK: Actions

    private func pick(_ serverID: String, _ serverName: String, _ prompt: MCPPrompt) {
        error = nil
        let choice = Picked(serverID: serverID, serverName: serverName, prompt: prompt)
        if prompt.arguments.isEmpty {
            insert(choice)
        } else {
            values = [:]
            withAnimation(Motion.reflow) { picked = choice }
        }
    }

    private func insert(_ choice: Picked) {
        busy = true
        error = nil
        let arguments = values.filter { !$0.value.trimmingCharacters(in: .whitespaces).isEmpty }
        Task { @MainActor in
            defer { busy = false }
            do {
                try await store.insertConnectorPrompt(serverID: choice.serverID, name: choice.prompt.name, arguments: arguments)
                store.haptics.fire(.success)
                onInserted()
            } catch {
                self.error = "Couldn't get “\(choice.prompt.displayTitle)” from \(choice.serverName): \(error.localizedDescription)"
                store.haptics.fire(.warning)
            }
        }
    }

    // MARK: Look (the tray's grouped cards)

    private func card<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 0) { content() }
            .background(Praxis.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Praxis.hairline, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private var divider: some View {
        Rectangle().fill(Praxis.hairline).frame(height: 1).padding(.leading, 44)
    }
}
