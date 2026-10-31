import SwiftUI

struct CloudCatalogModelsScreen: View {
    @Environment(ChatStore.self) private var store
    let services: CloudServices
    @State private var query = ""
    @State private var providerID = ""
    var body: some View {
        CloudSettingsPage(title: "Models & favorites") {
            SettingsCard {
                Picker("Provider", selection: $providerID) {
                    Text("All providers").tag("")
                    ForEach(services.providers) { Text($0.name).tag($0.id) }
                }.tint(Praxis.ink).padding(14)
            }
            CloudCatalogModelList(services: services, selectedID: store.model.id) { model in store.model = services.adapter(model) }
        }
        .searchable(text: $query, prompt: "Search models on server")
        .task(id: query + "\u{0}" + providerID) {
            do {
                try await Task.sleep(for: .milliseconds(250))
                try await services.searchModels(query: query, providerID: providerID.isEmpty ? nil : providerID)
            } catch is CancellationError { } catch { }
        }
    }
}

/// Shared by settings and the tray. At most one server page is initially
/// rendered; a button fetches the next cursor, keeping large catalogs cheap.
struct CloudCatalogModelList: View {
    let services: CloudServices
    var selectedID: String
    var select: (CloudCatalogModel) -> Void
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if services.loadingModels && services.models.isEmpty { ProgressView().frame(maxWidth: .infinity) }
            if services.modelQuery.isEmpty && services.modelProviderID == nil && !services.favoriteModels.isEmpty {
                SettingsSectionTitle("Favorites")
                SettingsCard { ForEach(services.favoriteModels, id: \.selectionID) { model in row(model); SettingsDivider() } }
            }
            if !services.models.isEmpty {
                SettingsCard { ForEach(services.models, id: \.selectionID) { model in row(model); SettingsDivider() } }
            } else if !services.loadingModels {
                Text(services.modelQuery.isEmpty ? "No models available. Add or refresh a provider in Settings." : "No models match “\(services.modelQuery)”.")
                    .font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk)
            }
            if services.nextModelCursor != nil {
                CloudSettingsAction("Load more models", identifier: "cloudLoadMoreModels") { try await services.loadMoreModels() }
            }
            if let error { CloudSettingsErrorText(message: error) }
            if let error = services.lastError { CloudSettingsErrorText(message: error) }
        }
    }

    private func row(_ model: CloudCatalogModel) -> some View {
        HStack(spacing: 8) {
            Button { select(model) } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(model.displayName).font(Type.inter(14, weight: .medium, .body)).foregroundStyle(Praxis.ink)
                        Text(services.providerName(model.providerId)).font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk)
                    }
                    Spacer(minLength: 2)
                    if selectedID == model.selectionID { Image(systemName: "checkmark").foregroundStyle(Praxis.ink) }
                }.contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel("Select \(model.displayName)")
            Button { preference(model, pinned: !model.pinned) } label: {
                Image(systemName: model.pinned ? "pin.fill" : "pin").frame(width: 36, height: 44)
            }.buttonStyle(.plain).foregroundStyle(Praxis.ink)
                .accessibilityLabel("\(model.pinned ? "Unpin" : "Pin") \(model.displayName)")
            Button { preference(model, favorite: !model.favorite) } label: {
                Image(systemName: model.favorite ? "star.fill" : "star").frame(width: 36, height: 44)
            }.buttonStyle(.plain).foregroundStyle(Praxis.ink)
                .accessibilityLabel("\(model.favorite ? "Remove favorite" : "Favorite") \(model.displayName)")
        }.padding(.horizontal, 14).frame(minHeight: 58)
    }

    private func preference(_ model: CloudCatalogModel, pinned: Bool? = nil, favorite: Bool? = nil) {
        Task { @MainActor in
            do { try await services.setModelPreference(model, pinned: pinned, favorite: favorite); error = nil }
            catch { self.error = error.localizedDescription }
        }
    }
}

struct CloudCatalogConnectorsScreen: View {
    let services: CloudServices
    var body: some View {
        CloudSettingsPage(title: "Connectors") {
            Text("Remote MCP servers run through your cloud server. Tool changes apply to new chats; turning a frozen tool off refuses it in the current chat.")
                .font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk)
            SettingsCard {
                ForEach(services.connectors) { connector in
                    NavigationLink { CloudCatalogConnectorScreen(services: services, connectorID: connector.id) } label: {
                        CloudSettingsRow(title: connector.name, value: connector.presentationStatus, symbol: "link")
                    }.buttonStyle(PressHighlightStyle())
                    SettingsDivider()
                }
                NavigationLink { CloudCatalogConnectorEditor(services: services) } label: {
                    CloudSettingsRow(title: "Add connector", symbol: "plus")
                }.buttonStyle(PressHighlightStyle()).accessibilityIdentifier("cloudAddConnector")
            }
        }
    }
}

struct CloudCatalogConnectorScreen: View {
    @Environment(\.dismiss) private var dismiss
    let services: CloudServices
    var connectorID: String
    @State private var tools: [CloudCatalogTool] = []
    @State private var resources: [CloudCatalogResource] = []
    @State private var error: String?
    @State private var resourceText: String?
    @State private var confirmDelete = false
    private var connector: CloudCatalogConnector? { services.connectors.first { $0.id == connectorID } }
    var body: some View {
        CloudSettingsPage(title: connector?.name ?? "Connector") {
            if let connector {
                Text(connector.url).font(Type.mono(12, .caption)).foregroundStyle(Praxis.mutedInk).textSelection(.enabled)
                Text(connector.presentationStatus).font(Type.inter(14, .body)).foregroundStyle(Praxis.secondaryInk)
                    .accessibilityIdentifier("cloudConnectorStatus")
                if let error = connector.error, !error.isEmpty { CloudSettingsErrorText(message: error) }
                CloudSettingsAction("Refresh connection", identifier: "cloudRefreshConnector") { try await services.refreshConnector(connectorID) }
                SettingsCard {
                    CloudSettingsToggle("Enabled", isOn: connector.enabled) {
                        try await services.patchConnector(connectorID, patch: CloudCatalogConnectorPatch(enabled: $0))
                    }
                    SettingsDivider()
                    CloudSettingsToggle("Trust connector", isOn: connector.trusted) {
                        try await services.patchConnector(connectorID, patch: CloudCatalogConnectorPatch(trusted: $0))
                    }
                }
                Text("Trusted tools can still require approval under the chat's policy.").font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk)
                if connector.needsSignIn || connector.authStatus != "none" {
                    CloudSettingsAction(connector.needsSignIn ? "Sign in" : "Reconnect account", identifier: "cloudConnectorSignIn") {
                        try await services.signInToConnector(connectorID)
                    }
                }
                NavigationLink { CloudCatalogConnectorEditor(services: services, connector: connector) } label: {
                    CloudSettingsRow(title: "Edit connection", symbol: "slider.horizontal.3")
                }.buttonStyle(PressHighlightStyle())
                SettingsSectionTitle("Tools")
                if tools.isEmpty { Text("No tools discovered. Refresh to try again.").font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk) }
                SettingsCard {
                    ForEach(tools) { tool in
                        CloudSettingsToggle(tool.name, subtitle: tool.description, isOn: !connector.disabledTools.contains(tool.name)) {
                            try await services.setToolEnabled(connectorID: connectorID, name: tool.name, enabled: $0)
                        }
                        SettingsDivider()
                    }
                }
                if !resources.isEmpty {
                    SettingsSectionTitle("Resources")
                    ForEach(resources) { resource in
                        CloudSettingsAction(resource.title ?? resource.name) {
                            let result = try await services.readResource(connectorID: connectorID, uri: resource.uri)
                            resourceText = result.contents.compactMap(\.text).joined(separator: "\n\n")
                        }
                    }
                    if let resourceText { Text(resourceText).font(Type.mono(12, .body)).textSelection(.enabled) }
                }
                CloudSettingsAction("Refresh tools & resources") { try await reload() }
                if let error { CloudSettingsErrorText(message: error) }
                Button("Delete connector", role: .destructive) { confirmDelete = true }.buttonStyle(.praxisText)
                if confirmDelete {
                    CloudSettingsAction("Confirm delete", destructive: true) { try await services.deleteConnector(connectorID); dismiss() }
                    Button("Cancel") { confirmDelete = false }.buttonStyle(.praxisText)
                }
            } else { Text("This connector is no longer installed.") }
        }
        .task {
            do { try await reload() } catch { self.error = error.localizedDescription }
        }
    }

    private func reload() async throws {
        tools = try await services.connectorTools(connectorID)
        resources = try await services.connectorResources(connectorID)
        error = nil
    }
}

struct CloudSettingsToggle: View {
    var title: String
    var subtitle: String?
    var isOn: Bool
    var action: @MainActor (Bool) async throws -> Void
    @State private var busy = false
    @State private var error: String?
    init(_ title: String, subtitle: String? = nil, isOn: Bool, action: @escaping @MainActor (Bool) async throws -> Void) {
        self.title = title; self.subtitle = subtitle; self.isOn = isOn; self.action = action
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Toggle(isOn: Binding(get: { isOn }, set: { value in
                guard !busy else { return }; busy = true; error = nil
                Task { @MainActor in
                    defer { busy = false }
                    do { try await action(value) } catch { self.error = error.localizedDescription }
                }
            })) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack { Text(title).font(Type.inter(14, .body)); if busy { ProgressView().controlSize(.mini) } }
                    if let subtitle, !subtitle.isEmpty { Text(subtitle).font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk).lineLimit(3) }
                }
            }.tint(Praxis.ink).disabled(busy).accessibilityLabel(title)
            if let error { CloudSettingsErrorText(message: error) }
        }.padding(.horizontal, 14).padding(.vertical, 10).frame(minHeight: 48)
    }
}

struct CloudCatalogConnectorEditor: View {
    @Environment(\.dismiss) private var dismiss
    let services: CloudServices
    var connector: CloudCatalogConnector?
    @State private var name = ""
    @State private var url = ""
    @State private var transport = "streamableHttp"
    @State private var token = ""
    @State private var loaded = false
    var body: some View {
        CloudSettingsPage(title: connector == nil ? "Add connector" : "Edit connector") {
            SettingsCard {
                SettingsField(title: "Name", text: $name, placeholder: "My connector")
                SettingsDivider()
                SettingsField(title: "Server URL", text: $url, placeholder: "https://example.com/mcp", keyboard: .URL, monospaced: true)
                SettingsDivider()
                Picker("Transport", selection: $transport) {
                    Text("Streamable HTTP").tag("streamableHttp"); Text("Legacy SSE").tag("sse")
                }.tint(Praxis.ink).padding(14)
                SettingsDivider()
                SecureField("Optional bearer token", text: $token).textInputAutocapitalization(.never).autocorrectionDisabled().padding(14)
                    .accessibilityLabel("Connector token")
            }
            Text("Tokens are write-only and encrypted by the server. OAuth sign-in is available after adding the connector. Local processes and stdio connectors are unsupported.")
                .font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk)
            CloudSettingsAction(connector == nil ? "Add connector" : "Save connector", identifier: "cloudSaveConnector") {
                defer { token = "" }
                _ = try await services.saveConnector(id: connector?.id, input: CloudCatalogConnectorInput(
                    name: name.trimmingCharacters(in: .whitespacesAndNewlines), url: url.trimmingCharacters(in: .whitespacesAndNewlines),
                    transport: transport, enabled: connector?.enabled ?? true, trusted: connector?.trusted ?? false,
                    disabledTools: connector?.disabledTools ?? [], token: token.isEmpty ? nil : token))
                dismiss()
            }.disabled(name.isEmpty || url.isEmpty)
        }
        .onAppear {
            guard !loaded else { return }; loaded = true
            if let connector { name = connector.name; url = connector.url; transport = connector.transport }
        }
        .onDisappear { token = "" }
    }
}

struct CloudSettingsConsentScreen: View {
    let services: CloudServices
    @State private var host = ""
    var body: some View {
        CloudSettingsPage(title: "AI data sharing") {
            Text("Allow each provider host before chat data or audio can be sent there. Withdrawing consent takes effect on the server.")
                .font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk)
            SettingsCard {
                ForEach(services.consents) { consent in
                    CloudSettingsToggle(consent.host, isOn: consent.allowed) { try await services.setConsent(host: consent.host, allowed: $0) }
                    SettingsDivider()
                }
            }
            SettingsCard { SettingsField(title: "Provider host", text: $host, placeholder: "api.example.com", keyboard: .URL, monospaced: true) }
            CloudSettingsAction("Allow host") {
                let text = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                guard let url = URL(string: "https://" + text), url.host == text, url.path.isEmpty, url.user == nil, url.port == nil, url.query == nil, url.fragment == nil else { throw CloudSettingsError.invalidRemoteURL }
                try await services.setConsent(host: text, allowed: true); host = ""
            }.disabled(host.isEmpty)
        }
    }
}
