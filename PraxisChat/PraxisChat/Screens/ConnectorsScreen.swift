import SwiftUI
import AgentCore
import AgentMCP

/// Settings → Connectors: installed remote MCP servers with their state,
/// and the three ways to add one (URL, pasted config, the registry).
struct ConnectorsScreen: View {
    let library: ConnectorLibrary
    @Binding var path: [SettingsSheet.Route]
    @Environment(ChatStore.self) private var store

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                installed
                addSection
                Text("Connectors are remote MCP servers. Praxis talks to them directly from this iPhone; servers that would run a program on the device aren't supported.")
                    .font(Type.inter(12, .caption))
                    .foregroundStyle(Praxis.mutedInk)
                    .padding(.horizontal, 4)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .background(Praxis.canvas)
        .navigationTitle("Connectors")
        .navigationBarTitleDisplayMode(.inline)
        .task { await checkUnknown() }
    }

    @ViewBuilder
    private var installed: some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsSectionTitle("Installed")
            if library.servers.isEmpty {
                Text("No connectors yet. Add one below to give the agent tools like your issue tracker or docs.")
                    .font(Type.inter(14, .subheadline))
                    .foregroundStyle(Praxis.secondaryInk)
                    .lineSpacing(4)
                    .padding(.horizontal, 4)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                SettingsCard {
                    ForEach(library.servers) { server in
                        if server.id != library.servers.first?.id { SettingsDivider() }
                        NavigationLink(value: SettingsSheet.Route.connector(server.id)) {
                            ConnectorRow(server: server, state: library.state(of: server.id))
                        }
                        .buttonStyle(PressHighlightStyle(cornerRadius: 18))
                    }
                }
            }
        }
    }

    private var addSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsSectionTitle("Add a connector")
            SettingsCard {
                addRow("link", "Add by URL", "A server address, with an API key if it needs one", .addConnectorURL)
                SettingsDivider()
                addRow("doc.plaintext", "Paste a config", "mcp.json or claude_desktop_config.json", .pasteConnectorConfig)
                SettingsDivider()
                addRow("square.grid.2x2", "Browse the MCP registry", "Public servers you can reach by URL", .connectorRegistry)
            }
        }
    }

    private func addRow(_ symbol: String, _ title: String, _ detail: String, _ route: SettingsSheet.Route) -> some View {
        NavigationLink(value: route) {
            HStack(spacing: 10) {
                Image(systemName: symbol).font(.system(size: 14)).foregroundStyle(Praxis.mutedInk).frame(width: 20)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(Type.inter(15, .body)).foregroundStyle(Praxis.ink)
                    Text(detail).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk).lineLimit(1)
                }
                Spacer()
                LucideIcon(name: "chevron-right", size: 14).foregroundStyle(Praxis.mutedInk)
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 56)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressHighlightStyle(cornerRadius: 18))
        .accessibilityLabel(title)
    }

    /// Fills in state for servers not checked yet this session. OAuth
    /// servers are left alone: a check could pop a sign-in sheet the
    /// user didn't ask for; their detail screen has the button.
    private func checkUnknown() async {
        let pending = library.servers.filter { server in
            guard server.enabled, library.state(of: server.id) == .notChecked else { return false }
            switch server.auth {
            case .none, .headers: return true
            case .oauth, .manualOAuth: return false
            }
        }
        // In parallel; each result lands in the library as it arrives.
        let connectors = library
        let tasks = pending.map { server in Task { _ = try? await connectors.review(server.id) } }
        for task in tasks { await task.value }
    }
}

/// One installed server: name, host, state and flags.
struct ConnectorRow: View {
    let server: MCPServerConfig
    let state: ConnectorState

    var body: some View {
        HStack(spacing: 10) {
            IntegrationAvatar(monogram: String(server.name.prefix(1)).uppercased())
            VStack(alignment: .leading, spacing: 2) {
                Text(server.name).font(Type.inter(15, weight: .semibold, .body)).foregroundStyle(Praxis.ink)
                HStack(spacing: 5) {
                    Circle().fill(state.tint).frame(width: 6, height: 6)
                    Text(subtitle).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk).lineLimit(1)
                }
            }
            Spacer()
            if server.trusted {
                Text("Trusted").font(Type.inter(12, weight: .medium, .caption)).foregroundStyle(Praxis.mutedInk)
            }
            LucideIcon(name: "chevron-right", size: 14).foregroundStyle(Praxis.mutedInk)
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 60)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(server.name), \(subtitle)\(server.trusted ? ", trusted" : "")")
    }

    private var subtitle: String {
        [state.summary, server.url.host()].compactMap { $0 }.joined(separator: " · ")
    }
}

/// What the UI says about a server, from the library's last results.
enum ConnectorState: Equatable {
    case off
    case needsSignIn(MCPAuthRequirement)
    case error(String)
    case connected(toolCount: Int)
    /// Works anonymously, but advertises sign-in (RFC 9728): some or all
    /// tools may refuse until the user signs in.
    case signInAvailable(toolCount: Int, MCPAuthRequirement)
    case notChecked

    var summary: String {
        switch self {
        case .off: return "Off"
        case .needsSignIn(.tokenHeader): return "Needs an access token"
        case .needsSignIn(.oauthNeedsClientCredentials): return "Needs an OAuth app"
        case .needsSignIn(.unsupported): return "Sign-in not supported"
        case .needsSignIn: return "Needs sign-in"
        case .error: return "Couldn't connect"
        case .connected(let count): return count == 1 ? "Connected · 1 tool" : "Connected · \(count) tools"
        case .signInAvailable(let count, _): return "\(count == 1 ? "1 tool" : "\(count) tools") · Sign-in available"
        case .notChecked: return "Not checked yet"
        }
    }

    var tint: Color {
        switch self {
        case .connected: return Praxis.success
        case .signInAvailable: return Color.orange
        case .needsSignIn, .error: return Praxis.destructive
        case .off, .notChecked: return Praxis.mutedInk.opacity(0.5)
        }
    }
}

extension ConnectorLibrary {
    func state(of id: String) -> ConnectorState {
        guard let server = server(id) else { return .notChecked }
        if let requirement = authRequirements[id], requirement != .none { return .needsSignIn(requirement) }
        if let error = lastErrors[id] { return .error(error) }
        if let tools = tools[id] {
            guard server.enabled else { return .off }
            if let need = signInNeed(id), need.isOAuth { return .signInAvailable(toolCount: tools.count, need) }
            return .connected(toolCount: tools.count)
        }
        return server.enabled ? .notChecked : .off
    }
}

// MARK: Detail

/// One server: state and sign-in, the enable and trust switches (with
/// what trust changes), name, tools, headers / OAuth client, removal.
struct ConnectorDetailScreen: View {
    let library: ConnectorLibrary
    let serverID: String
    @Binding var path: [SettingsSheet.Route]
    @Environment(ChatStore.self) private var store
    @State private var name = ""
    @State private var busy: String?
    @State private var actionError: String?
    @State private var confirmRemove = false
    @State private var headers: [HeaderDraft] = []
    @State private var headersDirty = false
    @State private var clientID = ""
    @State private var clientSecret = ""
    @State private var redirectURI = ""
    @State private var scopes = ""
    @State private var showManualOAuth = false

    private var server: MCPServerConfig? { library.server(serverID) }

    var body: some View {
        Group {
            if let server {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        statusSection(server)
                        switchesSection(server)
                        nameSection(server)
                        toolsSection
                        headersSection
                        signInSection(server)
                        SettingsActionButton(title: "Remove connector", role: .destructive) { confirmRemove = true }
                            .padding(.top, 6)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
                .scrollDismissesKeyboard(.interactively)
                .scrollEdgeEffectStyle(.soft, for: .top)
                .navigationTitle(server.name)
            } else {
                Color.clear
            }
        }
        .background(Praxis.canvas)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear(perform: load)
        .task {
            // Plain servers can be listed without any UI; OAuth ones wait
            // for a tap so a sign-in sheet never appears unasked.
            guard let server, library.tools[serverID] == nil, library.authRequirements[serverID] == nil else { return }
            if case .none = server.auth { await refresh() } else if case .headers = server.auth { await refresh() }
        }
        .confirmationDialog("Remove \(server?.name ?? "connector")?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                let id = serverID
                path.removeAll { $0 == .connector(id) }
                Task { await library.remove(id) }
                store.haptics.fire(.success)
            }
        } message: {
            Text("Its saved keys and sign-in are deleted. Chats that already use it keep its tools listed, but they won't run.")
        }
    }

    // MARK: Sections

    private func statusSection(_ server: MCPServerConfig) -> some View {
        let state = library.state(of: serverID)
        return VStack(alignment: .leading, spacing: 8) {
            SettingsSectionTitle("Status")
            SettingsCard {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        Circle().fill(state.tint).frame(width: 7, height: 7)
                        Text(state.summary).font(Type.inter(15, weight: .medium, .body)).foregroundStyle(Praxis.ink)
                            .accessibilityIdentifier("connectorStatus")
                        Spacer()
                        if let busy {
                            ProgressView().controlSize(.small)
                            Text(busy).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk)
                        }
                    }
                    Text(server.url.absoluteString).font(Type.mono(12, .footnote)).foregroundStyle(Praxis.secondaryInk)
                        .textSelection(.enabled).lineLimit(2)
                    if let detail = statusDetail(state) {
                        Text(detail).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.secondaryInk)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let actionError {
                        Text(actionError).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.destructive)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: 8) {
                if case .needsSignIn(.oauthAutomatic) = state {
                    SettingsActionButton(title: "Sign in", prominent: true) { Task { await signIn(automatic: true) } }
                } else if case .signInAvailable(_, .oauthAutomatic) = state {
                    SettingsActionButton(title: "Sign in", prominent: true) { Task { await signIn(automatic: true) } }
                } else if case .needsSignIn(.oauthNeedsClientCredentials) = state {
                    EmptyView()
                } else if case .signInAvailable(_, .oauthNeedsClientCredentials) = state {
                    EmptyView()
                } else {
                    SettingsActionButton(title: library.tools[serverID] == nil ? "Check connection" : "Refresh tools") {
                        Task { await refresh() }
                    }
                }
            }
            .disabled(busy != nil)
        }
    }

    private func statusDetail(_ state: ConnectorState) -> String? {
        switch state {
        case .needsSignIn(let requirement): return requirement.message
        case .signInAvailable(_, let requirement):
            let host = Self.host(of: requirement)
            return "It answered without signing in, but it supports signing in\(host.map { " with \($0)" } ?? ""). Tools that read your data may fail until you do."
        case .error(let message): return message
        case .off: return "Turned off: new chats leave it out, and chats that use it refuse its tools."
        default: return nil
        }
    }

    private func switchesSection(_ server: MCPServerConfig) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsCard {
                Toggle(isOn: Binding(get: { server.enabled }, set: { on in
                    store.haptics.fire(.selection)
                    Task { await library.setEnabled(serverID, on) }
                })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("On").font(Type.inter(15, .body)).foregroundStyle(Praxis.ink)
                        Text("New chats include it. Off also pauses it in chats that use it.")
                            .font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk)
                    }
                }
                .tint(Praxis.ink)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .accessibilityLabel("Connector on")
                SettingsDivider()
                Toggle(isOn: Binding(get: { server.trusted }, set: { on in
                    store.haptics.fire(.selection)
                    Task { await library.setTrusted(serverID, on) }
                })) {
                    Text("Trust this server").font(Type.inter(15, .body)).foregroundStyle(Praxis.ink)
                }
                .tint(Praxis.ink)
                .padding(.horizontal, 14)
                .frame(minHeight: 50)
                .accessibilityLabel("Trust this server")
            }
            Text(TrustExplanation.text)
                .font(Type.inter(12, .caption))
                .foregroundStyle(Praxis.mutedInk)
                .padding(.horizontal, 4)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func nameSection(_ server: MCPServerConfig) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsSectionTitle("Name")
            SettingsCard {
                HStack {
                    TextField(server.name, text: $name)
                        .font(Type.inter(15, .body))
                        .foregroundStyle(Praxis.ink)
                        .submitLabel(.done)
                        .onSubmit(rename)
                        .accessibilityLabel("Connector name")
                    if name.trimmingCharacters(in: .whitespaces) != server.name, !name.trimmingCharacters(in: .whitespaces).isEmpty {
                        Button("Rename", action: rename)
                            .buttonStyle(.praxisText)
                    }
                }
                .padding(.horizontal, 14)
                .frame(minHeight: 50)
            }
            Text("Shown in the tray and on approvals. Chats that already use it keep the old name in their tool list.")
                .font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk).padding(.horizontal, 4)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var toolsSection: some View {
        if let tools = library.tools[serverID] {
            VStack(alignment: .leading, spacing: 8) {
                SettingsSectionTitle(tools.count == 1 ? "1 tool" : "\(tools.count) tools")
                ToolList(tools: tools)
            }
        }
    }

    private var headersSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsSectionTitle("Headers")
            HeadersEditor(rows: $headers, onChange: { headersDirty = true })
            if headersDirty {
                SettingsActionButton(title: "Save headers", prominent: true) { Task { await saveHeaders() } }
            }
            Text("Sent with every request, e.g. Authorization: Bearer <token> or an API key header. Hidden values are kept in the Keychain.")
                .font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk).padding(.horizontal, 4)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    static func host(of requirement: MCPAuthRequirement) -> String? {
        switch requirement {
        case .oauthAutomatic(let issuer), .oauthNeedsClientCredentials(let issuer): return URL(string: issuer)?.host() ?? issuer
        default: return nil
        }
    }

    @ViewBuilder
    private func signInSection(_ server: MCPServerConfig) -> some View {
        let needsClient: Bool = {
            if case .oauthNeedsClientCredentials? = library.signInNeed(serverID) { return true }
            if case .manualOAuth = server.auth { return true }
            return false
        }()
        VStack(alignment: .leading, spacing: 8) {
            SettingsSectionTitle("Sign-in")
            switch server.auth {
            case .oauth, .manualOAuth:
                HStack(spacing: 8) {
                    SettingsActionButton(title: library.signedIn[serverID] == false ? "Sign in" : "Sign in again") {
                        Task { await signIn(automatic: false, force: library.signedIn[serverID] == true) }
                    }
                    SettingsActionButton(title: "Sign out") {
                        Task {
                            await library.signOut(serverID)
                            store.haptics.fire(.selection)
                        }
                    }
                }
                .disabled(busy != nil)
            case .none, .headers:
                if library.signInNeed(serverID) == nil {
                    Text("This server doesn't use sign-in. If it asks for one, Praxis offers it here.")
                        .font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk).padding(.horizontal, 4)
                }
            }
            if needsClient || showManualOAuth {
                ManualOAuthFields(clientID: $clientID, clientSecret: $clientSecret, redirectURI: $redirectURI, scopes: $scopes,
                                  issuer: issuer, advertisedScopes: library.signInOffers[serverID]?.scopes ?? [],
                                  recommendedScopes: library.signInOffers[serverID]?.recommendedScopes ?? [])
                SettingsActionButton(title: "Save and sign in", prominent: true) { Task { await saveManualClient() } }
                    .disabled(clientID.trimmingCharacters(in: .whitespaces).isEmpty || busy != nil)
            } else {
                Button("Use your own OAuth app") { withAnimation(Motion.reflow) { showManualOAuth = true } }
                    .buttonStyle(.praxisText(muted: true))
                    .padding(.horizontal, 4)
            }
        }
    }

    private var issuer: String? {
        switch library.signInNeed(serverID) {
        case .oauthNeedsClientCredentials(let issuer)?, .oauthAutomatic(let issuer)?: return issuer
        default: return library.signInOffers[serverID]?.issuer
        }
    }

    // MARK: Actions

    private func load() {
        guard let server else { return }
        name = server.name
        headers = server.headers.map { header in
            switch header.value {
            case .plain(let value): return HeaderDraft(name: header.name, value: value, isSecret: false, hasSaved: false)
            case .secret: return HeaderDraft(name: header.name, value: "", isSecret: true, hasSaved: true)
            }
        }
        headersDirty = false
        if case .manualOAuth(let id, _) = server.auth { clientID = id }
        redirectURI = server.oauthRedirectURI ?? ""
        scopes = server.oauthScopes?.joined(separator: " ") ?? ""
    }

    private func rename() {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, trimmed != server?.name else { return }
        Task { await library.rename(serverID, to: trimmed) }
        store.haptics.fire(.success)
    }

    private func refresh() async {
        busy = "Connecting…"
        actionError = nil
        defer { busy = nil }
        do {
            _ = try await library.review(serverID)
            store.haptics.fire(.success)
        } catch {
            store.haptics.fire(.warning)
        }
    }

    /// Sign-in through `ASWebAuthenticationSession` (the library's OAuth
    /// presenter). A server that answered 401 to a plain config switches
    /// to OAuth first.
    private func signIn(automatic: Bool, force: Bool = false) async {
        busy = "Signing in…"
        actionError = nil
        defer { busy = nil }
        if automatic { await library.useAutomaticOAuth(serverID) }
        do {
            try await library.signIn(serverID, force: force)
            store.haptics.fire(.success)
        } catch {
            if !(error is CancellationError) { actionError = error.localizedDescription }
            store.haptics.fire(.warning)
        }
    }

    private func saveManualClient() async {
        do {
            try await library.setManualOAuth(serverID, clientID: clientID, clientSecret: clientSecret,
                                             redirectURI: redirectURI, scopes: OAuthClientGuide.scopes(from: scopes))
            clientSecret = ""
        } catch {
            actionError = "Couldn't save the client: \(error.localizedDescription)"
            return
        }
        await signIn(automatic: false)
    }

    private func saveHeaders() async {
        do {
            try await library.setHeaders(serverID, headers.map(\.edit))
            load()
            store.haptics.fire(.success)
            await refresh()
        } catch {
            actionError = "Couldn't save the headers: \(error.localizedDescription)"
        }
    }
}

/// What trusting a server changes, in plain words (from `ToolPolicy`'s
/// table: untrusted MCP tools count as destructive whatever they claim).
enum TrustExplanation {
    static let text = "Trusting a server means Praxis believes what it says about its own tools. Tools it marks read-only then run without asking in Plan, Build and Auto, and tools it marks as safe run without asking in Auto. Untrusted, every tool counts as one that can change or delete things: it asks first in Build and Auto and is blocked in Ask and Plan. Only trust servers you know."
}

// MARK: Shared pieces

/// Tools as a server listed them, with the hints it gave.
struct ToolList: View {
    let tools: [MCPToolDefinition]

    var body: some View {
        SettingsCard {
            if tools.isEmpty {
                Text("This server lists no tools.")
                    .font(Type.inter(14, .subheadline)).foregroundStyle(Praxis.mutedInk)
                    .padding(14).frame(maxWidth: .infinity, alignment: .leading)
            }
            ForEach(Array(tools.enumerated()), id: \.element.name) { index, tool in
                if index > 0 { SettingsDivider() }
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(tool.displayTitle).font(Type.inter(15, weight: .medium, .body)).foregroundStyle(Praxis.ink)
                        Spacer(minLength: 4)
                        Text(hint(tool)).font(Type.inter(11, weight: .medium, .caption2)).foregroundStyle(Praxis.mutedInk)
                    }
                    if tool.displayTitle != tool.name {
                        Text(tool.name).font(Type.mono(11, .caption2)).foregroundStyle(Praxis.mutedInk)
                    }
                    if !tool.description.isEmpty {
                        Text(tool.description).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.secondaryInk)
                            .lineLimit(3)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .accessibilityElement(children: .combine)
            }
        }
    }

    /// The server's own claim — believed only once it's trusted.
    private func hint(_ tool: MCPToolDefinition) -> String {
        let traits = tool.annotations.traits
        if traits.contains(.readOnly) { return "Says read-only" }
        if traits.contains(.destructive) { return "Can change things" }
        return "Says safe"
    }
}

/// An editable header row. Secret values are never shown again: an
/// empty field on a saved secret keeps it.
struct HeaderDraft: Identifiable, Equatable {
    let id = UUID()
    var name: String
    var value: String
    var isSecret: Bool
    var hasSaved: Bool

    var edit: HeaderEdit {
        HeaderEdit(name: name, value: isSecret && hasSaved && value.isEmpty ? nil : value, isSecret: isSecret)
    }
}

struct HeadersEditor: View {
    @Binding var rows: [HeaderDraft]
    var onChange: () -> Void = {}

    var body: some View {
        SettingsCard {
            ForEach($rows) { $row in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        TextField("Header", text: $row.name)
                            .font(Type.mono(13, .body))
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .accessibilityLabel("Header name")
                        Button {
                            rows.removeAll { $0.id == row.id }
                            onChange()
                        } label: {
                            Image(systemName: "minus.circle").foregroundStyle(Praxis.mutedInk)
                        }
                        .accessibilityLabel("Remove header")
                    }
                    HStack(spacing: 8) {
                        Group {
                            if row.isSecret {
                                SecureField(row.hasSaved ? "Saved — type to replace" : "Value", text: $row.value)
                            } else {
                                TextField("Value", text: $row.value)
                            }
                        }
                        .font(Type.mono(13, .body))
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityLabel("Header value")
                        Toggle("Hidden", isOn: $row.isSecret)
                            .font(Type.inter(12, .caption))
                            .toggleStyle(.button)
                            .tint(Praxis.secondaryInk)
                            .accessibilityLabel("Keep value hidden")
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .onChange(of: row) { _, _ in onChange() }
                SettingsDivider()
            }
            Button {
                rows.append(HeaderDraft(name: "Authorization", value: "", isSecret: true, hasSaved: false))
                onChange()
            } label: {
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
            .accessibilityLabel("Add header")
        }
    }
}

/// Client ID (+ optional secret, redirect and scopes) for servers whose
/// sign-in has no automatic app registration, with step-by-step setup
/// for the provider (Google gets its exact console steps).
struct ManualOAuthFields: View {
    @Binding var clientID: String
    @Binding var clientSecret: String
    @Binding var redirectURI: String
    /// Space-separated.
    @Binding var scopes: String
    var issuer: String?
    /// What the server's metadata lists.
    var advertisedScopes: [String] = []
    /// The least-privilege subset that prefills `scopes`
    /// (`MCPSignInOffer.recommendedScopes`); empty = all advertised.
    var recommendedScopes: [String] = []

    var body: some View {
        let guide = OAuthClientGuide(issuer: issuer)
        let prefill = OAuthClientGuide.prefill(recommended: recommendedScopes, advertised: advertisedScopes)
        VStack(alignment: .leading, spacing: 8) {
            Text(guide.intro)
                .font(Type.inter(13, .footnote)).foregroundStyle(Praxis.secondaryInk).padding(.horizontal, 4)
                .fixedSize(horizontal: false, vertical: true)
            SettingsCard {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(guide.steps.enumerated()), id: \.offset) { index, step in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text("\(index + 1).").font(Type.inter(13, weight: .semibold, .footnote)).foregroundStyle(Praxis.ink)
                            Text(LocalizedStringKey(step)).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.secondaryInk)
                                .fixedSize(horizontal: false, vertical: true)
                                .textSelection(.enabled)
                        }
                    }
                    if guide.isGoogle {
                        HStack(spacing: 6) {
                            Text("Bundle ID").font(Type.inter(12, weight: .medium, .caption)).foregroundStyle(Praxis.mutedInk)
                            Text(OAuthClientGuide.bundleID).font(Type.mono(12, .caption)).foregroundStyle(Praxis.ink)
                                .textSelection(.enabled)
                            Spacer()
                            Button("Copy") { UIPasteboard.general.string = OAuthClientGuide.bundleID }
                                .buttonStyle(.praxisText)
                                .accessibilityLabel("Copy bundle ID")
                        }
                    }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            SettingsCard {
                SettingsField(title: "Client ID", text: $clientID,
                              placeholder: guide.isGoogle ? "…apps.googleusercontent.com" : "From the provider's developer settings",
                              monospaced: true)
                SettingsDivider()
                VStack(alignment: .leading, spacing: 4) {
                    Text(guide.isGoogle ? "Client secret (iOS clients have none)" : "Client secret (if it gave you one)")
                        .font(Type.inter(12, weight: .medium, .caption)).foregroundStyle(Praxis.mutedInk)
                    SecureField("Optional", text: $clientSecret)
                        .font(Type.mono(14, .body))
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityLabel("Client secret")
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                SettingsDivider()
                SettingsField(title: "Redirect URL", text: $redirectURI, placeholder: OAuthClientGuide.defaultRedirect, monospaced: true)
                SettingsDivider()
                SettingsField(title: "Scopes (space-separated)", text: $scopes, placeholder: "What the server asks for", monospaced: true)
                let more = OAuthClientGuide.unrequested(advertisedScopes, field: scopes)
                if !more.isEmpty {
                    SettingsDivider()
                    MoreScopesList(scopes: more) { added in
                        let current = OAuthClientGuide.scopes(from: scopes) ?? []
                        scopes = (current + added).joined(separator: " ")
                    }
                }
            }
            Text(guide.footnote(narrowed: Set(prefill) != Set(advertisedScopes)))
                .font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk).padding(.horizontal, 4)
                .fixedSize(horizontal: false, vertical: true)
        }
        .onAppear {
            if scopes.isEmpty, !prefill.isEmpty { scopes = prefill.joined(separator: " ") }
            deriveRedirect(from: clientID, previous: nil)
        }
        .onChange(of: clientID) { old, new in deriveRedirect(from: new, previous: old) }
    }

    /// Google iOS clients redirect to their reversed client ID: fill it in
    /// (and keep following the client ID while the user hasn't edited it).
    private func deriveRedirect(from id: String, previous: String?) {
        let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
        let derived = OAuthClientGuide.redirect(forClientID: trimmed)
        let previousDerived = previous.flatMap { OAuthClientGuide.redirect(forClientID: $0.trimmingCharacters(in: .whitespacesAndNewlines)) }
        if redirectURI.isEmpty || redirectURI == previousDerived {
            redirectURI = derived ?? ""
        }
    }
}

/// Scopes the server lists that sign-in won't ask for: tap one to add it
/// (widening is a deliberate choice; least privilege is the default).
private struct MoreScopesList: View {
    let scopes: [String]
    let add: ([String]) -> Void
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { withAnimation(Motion.reflow) { expanded.toggle() } } label: {
                HStack {
                    Text("\(scopes.count) more the server offers")
                        .font(Type.inter(12, weight: .medium, .caption)).foregroundStyle(Praxis.mutedInk)
                    Spacer()
                    Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Praxis.mutedInk).rotationEffect(.degrees(expanded ? 180 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(scopes.count) more scopes the server offers")
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            if expanded {
                ForEach(scopes, id: \.self) { scope in
                    Button { add([scope]) } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "plus.circle").font(.system(size: 13)).foregroundStyle(Praxis.secondaryInk)
                            Text(OAuthClientGuide.shortName(scope)).font(Type.mono(13, .caption)).foregroundStyle(Praxis.ink)
                            Spacer(minLength: 0)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Add scope \(OAuthClientGuide.shortName(scope))")
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}

/// Full-width capsule action in the Settings look.
struct SettingsActionButton: View {
    let title: String
    var prominent = false
    var role: ButtonRole?
    let action: () -> Void

    var body: some View {
        if prominent {
            Button(action: action) {
                PraxisButtonLabel(title)
            }
            .buttonStyle(.praxisPrimary(fillsWidth: true))
            .accessibilityLabel(title)
        } else {
            Button(role: role, action: action) {
                PraxisButtonLabel(title)
            }
            .buttonStyle(.praxisSecondary(fillsWidth: true))
            .accessibilityLabel(title)
        }
    }
}
