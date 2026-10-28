import SwiftUI
import AgentCore
import AgentProviders
import AgentMCP
import AgentSkills

/// Settings: model providers (add / edit / delete, Test connection, model
/// choice), connectors, skills and AI-data sharing. Reached from
/// History's options menu, the tray's model page and the tray's
/// "Manage connectors" (which opens straight on Connectors).
struct SettingsSheet: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var path: [Route] = []

    enum Route: Hashable {
        case edit(UUID)
        case add(ProviderPreset)
        case connectors
        case connector(String)
        case addConnectorURL
        case pasteConnectorConfig
        case connectorRegistry
        /// A candidate to fill in, install and review; `values` were
        /// already typed on the previous screen (a credential).
        case installConnector(MCPInstallCandidate, values: [String: String])
        case skills
        case skillBrowser
        case registrySkill(RegistrySkill, SkillRegistry)
        case imageReader
        case voice
    }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                if let services = store.services {
                    VStack(alignment: .leading, spacing: 26) {
                        providerList(services.settings)
                        toolsSection(services)
                        sharingSection(services.consent)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
            }
            .background(Praxis.canvas)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .font(Type.inter(15, weight: .semibold, .body))
                        .foregroundStyle(Praxis.ink)
                }
            }
            .navigationDestination(for: Route.self) { route in
                if let services = store.services {
                    destination(route, services)
                }
            }
        }
        .presentationDetents([.large])
        .onAppear {
            // Opened from elsewhere on a specific page (no push animation).
            let page = store.settingsPage
            store.settingsPage = .root
            var start = Transaction()
            start.disablesAnimations = true
            withTransaction(start) {
                switch page {
                case .root: break
                case .connectors: path = [.connectors]
                case .connector(let id): path = [.connectors, .connector(id)]
                case .skills: path = [.skills]
                case .voice: path = [.voice]
                }
            }
        }
    }

    @ViewBuilder
    private func destination(_ route: Route, _ services: AgentServices) -> some View {
        let settings = services.settings
        switch route {
        case .edit(let id):
            if let profile = settings.profile(id) {
                ProviderEditor(settings: settings, profile: profile, isNew: false) { path.removeAll() }
            }
        case .add(let preset):
            ProviderEditor(settings: settings, profile: .draft(preset), isNew: true) { path.removeAll() }
        case .connectors:
            ConnectorsScreen(library: services.connectors, path: $path)
        case .connector(let id):
            ConnectorDetailScreen(library: services.connectors, serverID: id, path: $path)
        case .addConnectorURL:
            AddConnectorByURLScreen(path: $path)
        case .pasteConnectorConfig:
            PasteConnectorConfigScreen(path: $path)
        case .connectorRegistry:
            ConnectorRegistryScreen(path: $path)
        case .installConnector(let candidate, let values):
            InstallConnectorScreen(library: services.connectors, candidate: candidate, prefilled: values, path: $path)
        case .skills:
            SkillsScreen(library: services.skills)
        case .skillBrowser:
            SkillRegistryBrowserScreen(library: services.skills)
        case .registrySkill(let skill, let registry):
            RegistrySkillDetailScreen(library: services.skills, skill: skill, registry: registry)
        case .imageReader:
            ImageReaderScreen(settings: settings, consent: services.consent)
        case .voice:
            VoiceSettingsScreen(settings: services.voice)
        }
    }

    // MARK: Connectors, skills, sharing

    private func toolsSection(_ services: AgentServices) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SettingsSectionTitle("Tools")
            SettingsCard {
                navigationRow(.connectors, symbol: "link", title: "Connectors",
                              value: countLabel(services.connectors.servers.count, "installed"))
                SettingsDivider()
                navigationRow(.skills, symbol: "wrench.and.screwdriver", title: "Skills",
                              value: countLabel(services.skills.skills.count, "installed"))
                SettingsDivider()
                navigationRow(.imageReader, symbol: "eye", title: "Image reading model",
                              value: services.settings.imageReaderDisplayName ?? "Off")
                SettingsDivider()
                navigationRow(.voice, symbol: "waveform", title: "Voice input",
                              value: services.voice.isConfigured ? services.voice.selectedModelID : "Off")
            }
        }
    }

    private func countLabel(_ count: Int, _ noun: String) -> String {
        count == 0 ? "None" : "\(count) \(noun)"
    }

    private func navigationRow(_ route: Route, symbol: String, title: String, value: String) -> some View {
        NavigationLink(value: route) {
            HStack(spacing: 10) {
                Image(systemName: symbol).font(.system(size: 14)).foregroundStyle(Praxis.mutedInk).frame(width: 20)
                Text(title).font(Type.inter(15, .body)).foregroundStyle(Praxis.ink)
                Spacer()
                Text(value).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk)
                LucideIcon(name: "chevron-right", size: 14).foregroundStyle(Praxis.mutedInk)
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressHighlightStyle(cornerRadius: 18))
        .accessibilityLabel(title)
        .accessibilityValue(value)
    }

    /// Hosts allowed to receive chat data, revocable one by one.
    private func sharingSection(_ consent: AIDataConsent) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SettingsSectionTitle("AI data sharing")
            if consent.grants.isEmpty {
                Text("Praxis asks before it first sends a chat to a provider. Providers you allow show up here.")
                    .font(Type.inter(14, .subheadline))
                    .foregroundStyle(Praxis.secondaryInk)
                    .lineSpacing(4)
                    .padding(.horizontal, 4)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                SettingsCard {
                    ForEach(consent.grants) { grant in
                        if grant.id != consent.grants.first?.id { SettingsDivider() }
                        HStack(spacing: 10) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(grant.host).font(Type.inter(15, weight: .semibold, .body)).foregroundStyle(Praxis.ink)
                                Text("\(grant.providerName) · allowed \(grant.grantedAt.formatted(date: .abbreviated, time: .omitted))")
                                    .font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk).lineLimit(1)
                            }
                            Spacer()
                            Button("Withdraw", role: .destructive) {
                                store.haptics.fire(.selection)
                                withAnimation(Motion.reflow) { consent.revoke(grant.host) }
                            }
                            .buttonStyle(.praxisText)
                            .accessibilityLabel("Withdraw sharing with \(grant.host)")
                        }
                        .padding(.horizontal, 14)
                        .frame(minHeight: 60)
                    }
                }
                Text("After withdrawing, Praxis asks again before sending anything to that provider.")
                    .font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk).padding(.horizontal, 4)
            }
        }
    }

    private func providerList(_ settings: ProviderSettings) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SettingsSectionTitle("Model providers")
            if settings.profiles.isEmpty {
                Text(store.isLive
                     ? "No provider yet. Add one to get real answers."
                     : "You're chatting with the built-in demo. Add a provider (your own API key, or a server on your network) to chat with a real model.")
                    .font(Type.inter(14, .subheadline))
                    .foregroundStyle(Praxis.secondaryInk)
                    .lineSpacing(4)
                    .padding(.horizontal, 4)
            } else {
                SettingsCard {
                    ForEach(settings.profiles) { profile in
                        if profile.id != settings.profiles.first?.id { SettingsDivider() }
                        NavigationLink(value: Route.edit(profile.id)) {
                            HStack(spacing: 10) {
                                IntegrationAvatar(monogram: String(profile.name.prefix(1)).uppercased())
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(profile.name).font(Type.inter(15, weight: .semibold, .body)).foregroundStyle(Praxis.ink)
                                    Text(subtitle(profile))
                                        .font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk).lineLimit(1)
                                }
                                Spacer()
                                if settings.selectedProfileID == profile.id {
                                    Text("In use").font(Type.inter(12, weight: .medium, .caption)).foregroundStyle(Praxis.mutedInk)
                                }
                                LucideIcon(name: "chevron-right", size: 14).foregroundStyle(Praxis.mutedInk)
                            }
                            .padding(.horizontal, 14)
                            .frame(minHeight: 60)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(PressHighlightStyle(cornerRadius: 18))
                        .accessibilityLabel("\(profile.name)\(settings.selectedProfileID == profile.id ? ", in use" : "")")
                    }
                }
            }
            Menu {
                ForEach(ProviderPreset.allCases) { preset in
                    Button(preset.displayName) { path.append(.add(preset)) }
                }
            } label: {
                PraxisButtonLabel("Add provider", systemImage: "plus")
            }
            .buttonStyle(.praxisPrimary(fillsWidth: true))
            .padding(.top, 4)
            .accessibilityLabel("Add provider")

            Text("API keys are kept in this device's Keychain and are only sent to the provider you configure.")
                .font(Type.inter(12, .caption))
                .foregroundStyle(Praxis.mutedInk)
                .padding(.horizontal, 4)
                .padding(.top, 6)
        }
    }

    private func subtitle(_ profile: ProviderProfile) -> String {
        let host = profile.endpoint.baseURL.host() ?? profile.endpoint.baseURL.absoluteString
        return profile.defaultModel.isEmpty ? host : "\(profile.defaultModel) · \(host)"
    }
}

// MARK: Editor

/// One profile: preset, base URL, key, model, headers, capabilities, and
/// Test connection. Edits stay local until Save.
private struct ProviderEditor: View {
    let settings: ProviderSettings
    let isNew: Bool
    var onClose: () -> Void

    @Environment(ChatStore.self) private var store
    @State private var draft: ProviderProfile
    @State private var baseURLText: String
    @State private var apiKey = ""
    @State private var removeKey = false
    @State private var headers: [HeaderRow]
    @State private var report: ProbeReport?
    @State private var testing = false
    @State private var error: String?
    @State private var confirmDelete = false

    struct HeaderRow: Identifiable, Equatable {
        let id = UUID()
        var name: String
        var value: String
    }

    init(settings: ProviderSettings, profile: ProviderProfile, isNew: Bool, onClose: @escaping () -> Void) {
        self.settings = settings
        self.isNew = isNew
        self.onClose = onClose
        _draft = State(initialValue: profile)
        _baseURLText = State(initialValue: isNew ? (profile.preset.defaultBaseURL?.absoluteString ?? "") : profile.endpoint.baseURL.absoluteString)
        _headers = State(initialValue: profile.endpoint.extraHeaders.sorted { $0.key < $1.key }.map { HeaderRow(name: $0.key, value: $0.value) })
    }

    private var hasSavedKey: Bool { !isNew && settings.hasAPIKey(draft.id) }

    /// Models from the last test, else the profile's cached list.
    private var models: [ModelInfo] {
        if let report, !report.models.isEmpty { return report.models }
        return settings.models(for: draft.id)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                connectionSection
                modelSection
                testSection
                headersSection
                capabilitiesSection
                if !isNew { dangerSection }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Praxis.canvas)
        .navigationTitle(isNew ? "Add provider" : draft.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Save", action: save)
                    .font(Type.inter(15, weight: .semibold, .body))
                    .foregroundStyle(Praxis.ink)
                    .accessibilityLabel("Save provider")
            }
        }
        .task {
            // Fill the model list for a saved profile that has none yet.
            if !isNew, settings.models(for: draft.id).isEmpty { await settings.refreshModels(for: draft.id) }
        }
        .confirmationDialog("Delete \(draft.name)?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                settings.delete(draft.id)
                store.providersChanged()
                onClose()
            }
        } message: {
            Text("Its API key is removed from the Keychain.")
        }
    }

    // MARK: Sections

    private var connectionSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsSectionTitle("Connection")
            SettingsCard {
                HStack {
                    Text("Preset").font(Type.inter(15, .body)).foregroundStyle(Praxis.ink)
                    Spacer()
                    Menu {
                        ForEach(ProviderPreset.allCases) { preset in
                            Button(preset.displayName) { apply(preset) }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Text(draft.preset.displayName).font(Type.inter(15, .body))
                            Image(systemName: "chevron.up.chevron.down").font(.system(size: 11))
                        }
                        .foregroundStyle(Praxis.secondaryInk)
                    }
                    .accessibilityLabel("Preset, \(draft.preset.displayName)")
                }
                .padding(.horizontal, 14)
                .frame(minHeight: 50)
                SettingsDivider()
                SettingsField(title: "Name", text: $draft.name, placeholder: draft.preset.displayName)
                SettingsDivider()
                SettingsField(title: "Base URL", text: $baseURLText, placeholder: draft.preset.baseURLPlaceholder,
                              keyboard: .URL, monospaced: true)
                SettingsDivider()
                VStack(alignment: .leading, spacing: 4) {
                    Text("API key").font(Type.inter(12, weight: .medium, .caption)).foregroundStyle(Praxis.mutedInk)
                    SecureField(hasSavedKey && !removeKey ? "Saved — type to replace" :
                                    (draft.preset.requiresAPIKey ? "Required" : "Optional for local servers"),
                                text: $apiKey)
                        .font(Type.mono(14, .body))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textContentType(.password)
                        .accessibilityLabel("API key")
                    if hasSavedKey && !removeKey && apiKey.isEmpty {
                        Button("Remove saved key", role: .destructive) { removeKey = true }
                            .buttonStyle(.praxisText)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
            }
            if let error {
                Text(error).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.destructive).padding(.horizontal, 4)
            }
        }
    }

    private var modelSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsSectionTitle("Model")
            SettingsCard {
                SettingsField(title: "Model ID", text: $draft.defaultModel,
                              placeholder: models.first?.id ?? "e.g. claude-sonnet-4-5 or gpt-5", monospaced: true)
                if !models.isEmpty {
                    SettingsDivider()
                    HStack {
                        Text("\(models.count) available").font(Type.inter(15, .body)).foregroundStyle(Praxis.ink)
                        Spacer()
                        Menu {
                            ForEach(models) { model in
                                Button {
                                    draft.defaultModel = model.id
                                } label: {
                                    let label = model.displayName
                                        + (settings.toolSupport(profileID: draft.id, model: model.id) == .unsupported ? " · No tools" : "")
                                    if model.id == draft.defaultModel { Label(label, systemImage: "checkmark") }
                                    else { Text(label) }
                                }
                            }
                        } label: {
                            HStack(spacing: 4) {
                                Text("Choose").font(Type.inter(15, weight: .medium, .body))
                                Image(systemName: "chevron.up.chevron.down").font(.system(size: 11))
                            }
                            .foregroundStyle(Praxis.secondaryInk)
                        }
                        .accessibilityLabel("Choose model")
                    }
                    .padding(.horizontal, 14)
                    .frame(minHeight: 50)
                }
            }
            if !isNew, settings.refreshingModels.contains(draft.id) {
                Text("Loading models…").font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk).padding(.horizontal, 4)
            } else if models.isEmpty {
                Text("Run Test connection to list the server's models, or type a model ID.")
                    .font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk).padding(.horizontal, 4)
            }
        }
    }

    private var testSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(action: test) {
                PraxisButtonLabel(testing ? "Testing…" : "Test connection", working: testing)
            }
            .buttonStyle(.praxisSecondary(fillsWidth: true))
            .disabled(testing)
            .accessibilityLabel("Test connection")

            if let report {
                SettingsCard {
                    ForEach(report.checks) { check in
                        if check.id != report.checks.first?.id { SettingsDivider() }
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: Self.symbol(check.status))
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(check.status == .failed ? Praxis.destructive
                                                 : check.status == .passed ? Praxis.success : Praxis.mutedInk)
                                .frame(width: 20)
                                .padding(.top, 2)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(check.title).font(Type.inter(15, weight: .medium, .body)).foregroundStyle(Praxis.ink)
                                Text(check.detail).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.secondaryInk)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .accessibilityElement(children: .combine)
                    }
                }
                if report.suggestedCapabilities != draft.endpoint.capabilities {
                    Button("Use the capabilities the test observed") {
                        withAnimation(Motion.snap) { draft.endpoint.capabilities = report.suggestedCapabilities }
                    }
                    .buttonStyle(.praxisText)
                    .padding(.horizontal, 4)
                }
            }
        }
    }

    private var headersSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsSectionTitle("Extra headers")
            SettingsCard {
                ForEach($headers) { $row in
                    HStack(spacing: 8) {
                        TextField("Header", text: $row.name)
                            .font(Type.mono(13, .body))
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                        TextField("Value", text: $row.value)
                            .font(Type.mono(13, .body))
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                        Button { headers.removeAll { $0.id == row.id } } label: {
                            Image(systemName: "minus.circle").foregroundStyle(Praxis.mutedInk)
                        }
                        .accessibilityLabel("Remove header")
                    }
                    .padding(.horizontal, 14)
                    .frame(minHeight: 46)
                    SettingsDivider()
                }
                Button { headers.append(HeaderRow(name: "", value: "")) } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "plus").font(.system(size: 12, weight: .semibold))
                        Text("Add header").font(Type.inter(15, .body))
                    }
                    .foregroundStyle(Praxis.ink)
                    .frame(maxWidth: .infinity, minHeight: 46, alignment: .leading)
                    .padding(.horizontal, 14)
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressHighlightStyle(cornerRadius: 18))
            }
            Text("Sent with every request, e.g. routing headers. Use the API key field for the key.")
                .font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk).padding(.horizontal, 4)
        }
    }

    private static let capabilityRows: [(String, WritableKeyPath<Capabilities, Bool>)] = [
        ("Tool calling", \.tools),
        ("Parallel tool calls", \.parallelToolCalls),
        ("Images (vision)", \.vision),
        ("PDF documents", \.documents),
        ("Images in tool results", \.imagesInToolResults),
        ("Reasoning effort", \.reasoningEffort),
        ("Streams token usage", \.streamUsage),
        ("Prompt caching (explicit)", \.explicitPromptCaching),
        ("Hosted web search", \.serverWebSearch),
        ("Mid-chat system messages", \.midConversationSystem),
    ]

    private var capabilitiesSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsSectionTitle("Capabilities")
            SettingsCard {
                ForEach(Array(Self.capabilityRows.enumerated()), id: \.offset) { index, row in
                    if index > 0 { SettingsDivider() }
                    Toggle(isOn: Binding(get: { draft.endpoint.capabilities[keyPath: row.1] },
                                         set: { draft.endpoint.capabilities[keyPath: row.1] = $0 })) {
                        Text(row.0).font(Type.inter(15, .body)).foregroundStyle(Praxis.ink)
                    }
                    .tint(Praxis.ink)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 46)
                }
            }
            Button("Reset to \(draft.preset.displayName) defaults") {
                withAnimation(Motion.snap) { draft.endpoint.capabilities = draft.preset.defaultCapabilities }
            }
            .buttonStyle(.praxisText(muted: true))
            .padding(.horizontal, 4)
        }
    }

    private var dangerSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            if settings.selectedProfileID != draft.id {
                Button {
                    settings.select(draft.id)
                    store.haptics.fire(.selection)
                } label: {
                    PraxisButtonLabel("Use this provider")
                }
                .buttonStyle(.praxisSecondary(fillsWidth: true))
            }
            Button(role: .destructive) { confirmDelete = true } label: {
                PraxisButtonLabel("Delete provider")
            }
            .buttonStyle(.praxisSecondary(fillsWidth: true))
            .accessibilityLabel("Delete provider")
        }
        .padding(.top, 6)
    }

    // MARK: Actions

    private func apply(_ preset: ProviderPreset) {
        guard preset != draft.preset else { return }
        var fresh = ProviderProfile.draft(preset)
        fresh = ProviderProfile(id: draft.id, name: isNew || draft.name == draft.preset.displayName ? preset.displayName : draft.name,
                                preset: preset, endpoint: fresh.endpoint, defaultModel: draft.defaultModel)
        draft = fresh
        baseURLText = preset.defaultBaseURL?.absoluteString ?? (isNew ? "" : baseURLText)
        report = nil
    }

    /// The draft as an endpoint, with the key typed here or the saved one.
    private func endpoint() -> ProviderEndpoint? {
        let text = baseURLText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: text), let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
              url.host() != nil else {
            error = "Enter a base URL like \(draft.preset.baseURLPlaceholder)."
            return nil
        }
        error = nil
        var endpoint = draft.endpoint
        endpoint.baseURL = url
        endpoint.extraHeaders = Dictionary(headers.compactMap { row in
            let name = row.name.trimmingCharacters(in: .whitespaces)
            return name.isEmpty ? nil : (name, row.value)
        }, uniquingKeysWith: { _, last in last })
        let typed = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        endpoint.apiKey = !typed.isEmpty ? typed : (removeKey || isNew ? "" : settings.apiKey(for: draft.id) ?? "")
        return endpoint
    }

    private func test() {
        guard let endpoint = endpoint() else { return }
        testing = true
        let model = draft.defaultModel.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            let result = await settings.test(endpoint, model: model)
            withAnimation(Motion.reveal) {
                report = result
                testing = false
                if draft.defaultModel.isEmpty, let first = result.testedModel ?? result.models.first?.id {
                    draft.defaultModel = first
                }
            }
            store.haptics.fire(result.isUsable ? .success : .warning)
        }
    }

    private func save() {
        guard var endpoint = endpoint() else { return }
        endpoint.apiKey = ""
        var profile = draft
        profile.name = profile.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if profile.name.isEmpty { profile.name = profile.preset.displayName }
        profile.defaultModel = profile.defaultModel.trimmingCharacters(in: .whitespacesAndNewlines)
        profile.endpoint = endpoint
        let typed = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let key: String? = !typed.isEmpty ? typed : (removeKey ? "" : nil)
        do {
            try settings.save(profile, apiKey: key)
        } catch {
            self.error = "Couldn't save the API key: \(error.localizedDescription)"
            return
        }
        if let report, !report.models.isEmpty { settings.store(report.models, for: profile.id) }
        else if settings.models(for: profile.id).isEmpty {
            let settings = settings, id = profile.id
            Task { await settings.refreshModels(for: id) }
        }
        store.providersChanged()
        store.haptics.fire(.success)
        onClose()
    }

    private static func symbol(_ status: ProbeReport.Status) -> String {
        switch status {
        case .passed: return "checkmark.circle"
        case .warning: return "exclamationmark.circle"
        case .failed: return "xmark.circle"
        case .skipped: return "minus.circle"
        }
    }
}

// MARK: Building blocks (the tray's grouped-card look)

struct SettingsCard<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) { content }
            .background(Praxis.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Praxis.hairline, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}

struct SettingsDivider: View {
    var body: some View {
        Rectangle().fill(Praxis.hairline).frame(height: 1).padding(.leading, 14)
    }
}

struct SettingsSectionTitle: View {
    let title: String
    init(_ title: String) { self.title = title }

    var body: some View {
        Text(title)
            .font(Type.inter(13, weight: .semibold, .footnote))
            .foregroundStyle(Praxis.mutedInk)
            .padding(.horizontal, 4)
            .accessibilityAddTraits(.isHeader)
    }
}

struct SettingsField: View {
    let title: String
    @Binding var text: String
    var placeholder = ""
    var keyboard: UIKeyboardType = .default
    var monospaced = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(Type.inter(12, weight: .medium, .caption)).foregroundStyle(Praxis.mutedInk)
            TextField(placeholder, text: $text)
                .font(monospaced ? Type.mono(14, .body) : Type.inter(15, .body))
                .foregroundStyle(Praxis.ink)
                .keyboardType(keyboard)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityLabel(title)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}
