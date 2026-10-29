import SwiftUI

struct CloudCatalogPromptsPage: View {
    @Environment(ChatStore.self) private var store
    let services: CloudServices
    var onBack: () -> Void
    var onInserted: () -> Void
    @State private var groups: [Group] = []
    @State private var picked: Choice?
    @State private var values: [String: String] = [:]
    @State private var loading = false
    @State private var error: String?
    private struct Group: Identifiable {
        var id: String
        var name: String
        var prompts: [CloudCatalogPrompt]
    }
    private struct Choice { var group: Group; var prompt: CloudCatalogPrompt }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Button { if picked == nil { onBack() } else { picked = nil; error = nil } } label: { Image(systemName: "chevron.left") }
                    .buttonStyle(.praxisIcon(.compact)).accessibilityLabel("Back")
                Text(picked?.prompt.displayTitle ?? "Prompts").font(Type.inter(15, weight: .semibold, .body)).foregroundStyle(Praxis.ink)
                Spacer()
                if loading { ProgressView().controlSize(.small) }
            }
            if let choice = picked {
                SettingsCard {
                    ForEach(choice.prompt.arguments ?? [], id: \.name) { argument in
                        SettingsField(title: (argument.title ?? argument.name) + (argument.required == true ? "" : " (optional)"),
                                      text: Binding(get: { values[argument.name] ?? "" }, set: { values[argument.name] = $0 }),
                                      placeholder: argument.description ?? "")
                        SettingsDivider()
                    }
                }
                CloudSettingsAction("Insert prompt") { try await insert(choice) }
                    .disabled((choice.prompt.arguments ?? []).contains { $0.required == true && (values[$0.name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
            } else {
                if groups.isEmpty && !loading { Text("None of this chat's connectors offer prompts.").font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk) }
                ForEach(groups) { group in
                    SettingsSectionTitle(group.name)
                    SettingsCard {
                        ForEach(group.prompts) { prompt in
                            Button {
                                values = [:]
                                let choice = Choice(group: group, prompt: prompt)
                                if (prompt.arguments ?? []).isEmpty {
                                    loading = true
                                    Task { @MainActor in
                                        defer { loading = false }
                                        do { try await insert(choice) } catch { self.error = error.localizedDescription }
                                    }
                                } else { picked = choice }
                            } label: { CloudSettingsRow(title: prompt.displayTitle, symbol: "text.bubble") }
                                .buttonStyle(PressHighlightStyle()).disabled(loading)
                            SettingsDivider()
                        }
                    }
                }
            }
            if let error { CloudSettingsErrorText(message: error) }
        }
        .task(id: store.selectedID) {
            groups = []; picked = nil; loading = true; error = nil
            defer { loading = false }
            let selected = store.selectedID
            do {
                for connector in store.trayConnectors.filter(\.isOn) {
                    let prompts = try await services.connectorPrompts(connector.id)
                    try Task.checkCancellation()
                    guard selected == store.selectedID else { return }
                    if !prompts.isEmpty { groups.append(Group(id: connector.id, name: connector.name, prompts: prompts)) }
                }
            } catch is CancellationError { } catch { self.error = error.localizedDescription }
        }
    }

    private func insert(_ choice: Choice) async throws {
        let selected = store.selectedID
        let arguments = values.filter { !$0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        let text = try await services.prompt(connectorID: choice.group.id, name: choice.prompt.name, arguments: arguments)
        try Task.checkCancellation()
        // A request may finish after the user switches chats. Never deposit
        // another chat's prompt into the newly-selected draft.
        guard selected == store.selectedID else { return }
        store.draft = store.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? text : store.draft + "\n\n" + text
        store.haptics.fire(.success); onInserted()
    }
}
