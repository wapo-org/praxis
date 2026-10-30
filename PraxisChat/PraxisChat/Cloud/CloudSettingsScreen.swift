import SwiftUI

private enum CloudSettingsRoute: Hashable {
    case account, providers, provider(String), addProvider, models
    case connectors, connector(String), addConnector, skills, registries, sharing, imageReader, voice
}

/// Cloud and sunset settings deliberately have separate navigation trees:
/// opening a cloud settings page never evaluates a native secret-backed view.
struct CloudSettingsSheet: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let services: CloudServices
    @State private var path: [CloudSettingsRoute] = []
    @State private var developer = false

    var body: some View {
        NavigationStack(path: $path) {
            CloudSettingsPage(title: "Settings") {
                VStack(alignment: .leading, spacing: 24) {
                    SettingsSectionTitle("Account")
                    SettingsCard {
                        link(.account, "Account & server", symbol: "person.crop.circle", value: services.account?.email ?? "Sign in")
                            .accessibilityIdentifier("cloudAccountServer")
                    }
                    SettingsSectionTitle("Models")
                    SettingsCard {
                        link(.providers, "Model providers", symbol: "server.rack", value: "\(services.providers.count)")
                        SettingsDivider()
                        link(.models, "Models & favorites", symbol: "sparkles", value: "")
                        SettingsDivider()
                        link(.imageReader, "Image reading model", symbol: "eye", value: "")
                    }
                    SettingsSectionTitle("Tools")
                    SettingsCard {
                        link(.connectors, "Connectors", symbol: "link", value: "\(services.connectors.count) installed")
                        SettingsDivider()
                        link(.skills, "Skills", symbol: "wrench.and.screwdriver", value: "\(services.skills.count) installed")
                        SettingsDivider()
                        link(.registries, "Skill registries", symbol: "books.vertical", value: "")
                        SettingsDivider()
                        link(.voice, "Voice input", symbol: "waveform", value: "")
                    }
                    SettingsCard { link(.sharing, "AI data sharing", symbol: "hand.raised", value: "") }
                    if let error = services.lastError { CloudSettingsErrorText(message: error) }
                    CloudSettingsAction("Refresh", identifier: "cloudRefresh") { await services.reload() }
                    Text("Praxis Chat · \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0")")
                        .font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .onLongPressGesture(minimumDuration: 2) { developer = true }
                        .accessibilityLabel("Praxis Chat version. Touch and hold for developer settings.")
                }
            }
            .accessibilityIdentifier("cloudSettings")
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() }.foregroundStyle(Praxis.ink) } }
            .navigationDestination(for: CloudSettingsRoute.self) { route in
                switch route {
                case .account: CloudSettingsAccountScreen(services: services)
                case .providers: providerList
                case .provider(let id): CloudSettingsProviderEditor(services: services, provider: services.providers.first { $0.id == id })
                case .addProvider: CloudSettingsProviderEditor(services: services, provider: nil)
                case .models: CloudCatalogModelsScreen(services: services)
                case .connectors: CloudCatalogConnectorsScreen(services: services)
                case .connector(let id): CloudCatalogConnectorScreen(services: services, connectorID: id)
                case .addConnector: CloudCatalogConnectorEditor(services: services)
                case .skills: CloudSettingsSkillsScreen(services: services)
                case .registries: CloudSettingsRegistriesScreen(services: services)
                case .sharing: CloudSettingsConsentScreen(services: services)
                case .imageReader: CloudSettingsImageReaderScreen(services: services)
                case .voice: CloudSettingsVoiceScreen(services: services)
                }
            }
        }
        .presentationDetents([.large])
        .sheet(isPresented: $developer) { CloudSettingsDeveloperScreen() }
        .task { await services.loadIfNeeded() }
        .onAppear {
            let page = store.settingsPage
            store.settingsPage = .root
            switch page {
            case .root: break
            case .connectors: path = [.connectors]
            case .connector(let id): path = [.connectors, .connector(id)]
            case .skills: path = [.skills]
            case .voice: path = [.voice]
            }
        }
    }

    private func link(_ route: CloudSettingsRoute, _ title: String, symbol: String, value: String) -> some View {
        NavigationLink(value: route) { CloudSettingsRow(title: title, value: value, symbol: symbol) }
            .buttonStyle(PressHighlightStyle(cornerRadius: 18))
            .accessibilityLabel(title).accessibilityValue(value)
    }

    private var providerList: some View {
        CloudSettingsPage(title: "Model providers") {
            VStack(alignment: .leading, spacing: 16) {
                Text("Provider keys are sent once to your cloud server and stored there. Saved keys are shown masked.")
                    .font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk)
                SettingsCard {
                    ForEach(services.providers) { provider in
                        NavigationLink(value: CloudSettingsRoute.provider(provider.id)) {
                            CloudSettingsRow(title: provider.name, value: provider.maskedKey, symbol: "server.rack")
                        }.buttonStyle(PressHighlightStyle())
                        SettingsDivider()
                    }
                    link(.addProvider, "Add provider", symbol: "plus", value: "")
                }
            }
        }
    }
}

struct CloudSettingsAccountScreen: View {
    let services: CloudServices
    @State private var email = ""
    @State private var password = ""
    @State private var overrideURL = ""
    @State private var savedOverride = false

    var body: some View {
        CloudSettingsPage(title: "Account & server") {
            VStack(alignment: .leading, spacing: 20) {
                SettingsSectionTitle("Server")
                SettingsCard {
                    Text(services.serverURL.absoluteString)
                        .font(Type.mono(13, .body)).foregroundStyle(Praxis.ink)
                        .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(14)
                        .accessibilityLabel("Server URL").accessibilityValue(services.serverURL.absoluteString)
                        .accessibilityIdentifier("cloudServerURL")
                }
                SettingsSectionTitle("Account")
                Text(services.account.map { $0.email ?? $0.name } ?? "Signed out")
                    .font(Type.inter(15, .body)).foregroundStyle(Praxis.ink)
                    .accessibilityIdentifier("cloudAccountStatus")
                if services.isSignedIn {
                    CloudSettingsAction("Sign out", identifier: "cloudSignOut", destructive: true) { try await services.signOut() }
                } else {
                    SettingsCard {
                        TextField("Email", text: $email).keyboardType(.emailAddress).textContentType(.username)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().padding(14)
                            .accessibilityLabel("Email").accessibilityIdentifier("cloudEmail")
                        SettingsDivider()
                        SecureField("Password", text: $password).textContentType(.password).padding(14)
                            .accessibilityLabel("Password").accessibilityIdentifier("cloudPassword")
                    }
                    CloudSettingsAction("Sign in", identifier: "cloudSignIn") {
                        defer { password = "" }
                        try await services.signIn(email: email, password: password)
                    }.disabled(email.isEmpty || password.isEmpty)
                }
                #if DEBUG
                SettingsSectionTitle("Development server")
                SettingsCard {
                    SettingsField(title: "Server override", text: $overrideURL, placeholder: "https://your-server.example", keyboard: .URL, monospaced: true)
                        .accessibilityIdentifier("cloudServerOverride")
                }
                CloudSettingsAction("Save server for next launch", identifier: "cloudApplyServer") {
                    let text = overrideURL.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard let url = URL(string: text) else { throw CloudAPIError.invalidServer }
                    let configuration = try CloudServerConfiguration(baseURL: url)
                    UserDefaults.standard.set(configuration.origin, forKey: "PraxisCloudServerURL")
                    savedOverride = true
                }
                if savedOverride { Text("Server saved. Restart Praxis to connect; sessions are separate for each server.").font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk) }
                #endif
            }
        }
        .onAppear { overrideURL = services.serverURL.absoluteString }
        .onDisappear { password = "" }
    }
}

private struct CloudSettingsDeveloperScreen: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage("PraxisNativeLoopEnabled") private var native = false
    var body: some View {
        NavigationStack {
            CloudSettingsPage(title: "Developer") {
                SettingsCard {
                    // SUNSET(native-loop): explicit opt-in; applies only after launch.
                    Toggle("Enable native loop", isOn: $native).tint(Praxis.ink).padding(14)
                        .accessibilityIdentifier("nativeLoopEnabled")
                }
                Text("Applies on next launch. With native mode enabled, the original device provider, connector and voice settings are available.")
                    .font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk).padding(.top, 12)
            }
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }.presentationDetents([.medium])
    }
}

struct CloudSettingsPage<Content: View>: View {
    var title: String
    @ViewBuilder var content: Content
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) { content }
                .padding(.horizontal, 16).padding(.vertical, 12).frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .background(Praxis.canvas).foregroundStyle(Praxis.ink)
        .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
    }
}

struct CloudSettingsRow: View {
    var title: String
    var value = ""
    var symbol = "chevron.right"
    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: symbol).font(.system(size: 14)).foregroundStyle(Praxis.mutedInk).frame(width: 20)
            Text(title).font(Type.inter(15, .body)).foregroundStyle(Praxis.ink)
            Spacer()
            if !value.isEmpty { Text(value).font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk).lineLimit(1) }
            LucideIcon(name: "chevron-right", size: 14).foregroundStyle(Praxis.mutedInk)
        }.padding(.horizontal, 14).frame(minHeight: 52).contentShape(Rectangle())
    }
}

struct CloudSettingsErrorText: View {
    let message: String
    var body: some View {
        Text(message).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.destructive)
            .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("cloudSettingsError")
    }
}

/// Each mutation reports progress and a visible retryable error. Values only
/// update after API success, so a failed trust/tool toggle never looks saved.
struct CloudSettingsAction: View {
    var title: String
    var identifier: String
    var destructive: Bool
    var action: @MainActor () async throws -> Void
    @State private var busy = false
    @State private var error: String?

    init(_ title: String, identifier: String = "", destructive: Bool = false, action: @escaping @MainActor () async throws -> Void) {
        self.title = title; self.identifier = identifier; self.destructive = destructive; self.action = action
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(role: destructive ? .destructive : nil) {
                guard !busy else { return }
                busy = true; error = nil
                Task { @MainActor in
                    defer { busy = false }
                    do { try await action() }
                    catch is CancellationError { }
                    catch { self.error = error.localizedDescription }
                }
            } label: { PraxisButtonLabel(title, working: busy) }
            .buttonStyle(.praxisSecondary(fillsWidth: true)).disabled(busy)
            .accessibilityIdentifier(identifier)
            if let error { CloudSettingsErrorText(message: error) }
        }
    }
}
