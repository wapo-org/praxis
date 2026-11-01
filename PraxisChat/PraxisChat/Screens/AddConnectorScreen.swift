import SwiftUI
import AgentCore
import AgentMCP

// MARK: Add by URL

/// A server address plus an optional credential header. Validation is
/// the installer's (https only, a real host); `{variables}` in the URL
/// become fields on the next screen.
struct AddConnectorByURLScreen: View {
    @Binding var path: [SettingsSheet.Route]
    @Environment(ChatStore.self) private var store
    @State private var url = ""
    @State private var name = ""
    @State private var auth: AuthChoice = .none
    @State private var headerName = "X-API-Key"
    @State private var secret = ""
    @State private var error: String?

    enum AuthChoice: String, CaseIterable, Identifiable {
        case none, bearer, apiKey
        var id: String { rawValue }
        var title: String {
            switch self {
            case .none: return "None"
            case .bearer: return "Bearer token"
            case .apiKey: return "API key header"
            }
        }
    }

    /// Input key the credential travels under (never shown).
    static let secretKey = "praxis_credential"

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 8) {
                    SettingsSectionTitle("Server")
                    SettingsCard {
                        SettingsField(title: "Server URL", text: $url, placeholder: "https://mcp.example.com/mcp",
                                      keyboard: .URL, monospaced: true)
                        SettingsDivider()
                        SettingsField(title: "Name (optional)", text: $name, placeholder: "From the address")
                    }
                    if let error {
                        Text(error).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.destructive)
                            .padding(.horizontal, 4)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("addConnectorError")
                    }
                }

                VStack(alignment: .leading, spacing: 8) {
                    SettingsSectionTitle("Authentication")
                    GlassSegmentedControl(options: AuthChoice.allCases, selection: auth, title: { $0.title }) { choice in
                        store.haptics.fire(.selection)
                        withAnimation(Motion.reflow) { auth = choice }
                    }
                    if auth != .none {
                        SettingsCard {
                            if auth == .apiKey {
                                SettingsField(title: "Header name", text: $headerName, placeholder: "X-API-Key", monospaced: true)
                                SettingsDivider()
                            }
                            VStack(alignment: .leading, spacing: 4) {
                                Text(auth == .bearer ? "Token" : "API key")
                                    .font(Type.inter(12, weight: .medium, .caption)).foregroundStyle(Praxis.mutedInk)
                                SecureField("Kept in the Keychain", text: $secret)
                                    .font(Type.mono(14, .body))
                                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                                    .accessibilityLabel(auth == .bearer ? "Token" : "API key")
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                        }
                    }
                    Text("Servers that use sign-in (OAuth) need nothing here: Praxis offers Sign In after connecting.")
                        .font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk).padding(.horizontal, 4)
                        .fixedSize(horizontal: false, vertical: true)
                }

                SettingsActionButton(title: "Continue", prominent: true, action: proceed)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .scrollDismissesKeyboard(.interactively)
        .scrollEdgeEffectStyle(.soft, for: .top)
        .background(Praxis.canvas)
        .navigationTitle("Add by URL")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func proceed() {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            withAnimation(Motion.reflow) { error = "Enter the server's URL." }
            store.haptics.fire(.warning)
            return
        }
        let label = name.trimmingCharacters(in: .whitespaces)
        var candidate: MCPInstallCandidate
        do {
            candidate = try ConnectorLibrary.candidate(url: trimmed, name: label.isEmpty ? nil : label)
        } catch {
            withAnimation(Motion.reflow) { self.error = error.localizedDescription }
            store.haptics.fire(.warning)
            return
        }
        var values: [String: String] = [:]
        let typed = secret.trimmingCharacters(in: .whitespacesAndNewlines)
        if auth != .none {
            let header = auth == .bearer ? "Authorization" : headerName.trimmingCharacters(in: .whitespaces)
            guard !typed.isEmpty, !header.isEmpty else {
                withAnimation(Motion.reflow) {
                    error = header.isEmpty ? "Enter the header name." : "Enter the \(auth == .bearer ? "token" : "API key"), or choose None."
                }
                store.haptics.fire(.warning)
                return
            }
            // A placeholder, so a value containing braces is never read
            // as one; the value itself goes to the Keychain on install.
            let template = auth == .bearer ? "Bearer {\(Self.secretKey)}" : "{\(Self.secretKey)}"
            candidate.headers.append(MCPHeaderTemplate(name: header, value: template, isSecret: true))
            candidate.inputs.append(MCPInstallInput(key: Self.secretKey, location: .header(header), isSecret: true))
            values[Self.secretKey] = typed
        }
        error = nil
        path.append(.installConnector(candidate, values: values))
    }
}

// MARK: Paste a config

/// `mcp.json` / `claude_desktop_config.json` / VS Code / registry JSON.
/// Remote entries become candidates; entries that would run a local
/// process are listed with the reason they can't be added.
struct PasteConnectorConfigScreen: View {
    @Binding var path: [SettingsSheet.Route]
    @Environment(ChatStore.self) private var store
    @State private var text = ""
    @State private var result: MCPImportResult?
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 8) {
                    SettingsSectionTitle("Config JSON")
                    TextEditor(text: $text)
                        .font(Type.mono(13, .body))
                        .foregroundStyle(Praxis.ink)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .scrollContentBackground(.hidden)
                        .frame(minHeight: 160)
                        .padding(10)
                        .background(Praxis.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Praxis.hairline, lineWidth: 1))
                        .accessibilityLabel("Config JSON")
                    HStack(spacing: 10) {
                        PasteButton(payloadType: String.self) { strings in
                            Task { @MainActor in
                                text = strings.first ?? ""
                                read()
                            }
                        }
                        .buttonBorderShape(.capsule)
                        .tint(Praxis.secondaryInk)
                        Spacer()
                        Button(action: read) { PraxisButtonLabel("Read config") }
                            .buttonStyle(.praxisPrimary)
                            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityLabel("Read config")
                    }
                    if let error {
                        Text(error).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.destructive).padding(.horizontal, 4)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                if let result { results(result) }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .scrollDismissesKeyboard(.interactively)
        .scrollEdgeEffectStyle(.soft, for: .top)
        .background(Praxis.canvas)
        .navigationTitle("Paste a config")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func results(_ result: MCPImportResult) -> some View {
        if !result.candidates.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SettingsSectionTitle("Can be added")
                SettingsCard {
                    ForEach(Array(result.candidates.enumerated()), id: \.offset) { index, candidate in
                        if index > 0 { SettingsDivider() }
                        NavigationLink(value: SettingsSheet.Route.installConnector(candidate, values: [:])) {
                            CandidateRow(candidate: candidate)
                        }
                        .buttonStyle(PressHighlightStyle(cornerRadius: 18))
                    }
                }
            }
        }
        if !result.rejected.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SettingsSectionTitle("Can't be added")
                SettingsCard {
                    ForEach(Array(result.rejected.enumerated()), id: \.offset) { index, rejection in
                        if index > 0 { SettingsDivider() }
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: "xmark.circle").font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(Praxis.destructive).frame(width: 20).padding(.top, 2)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(rejection.name).font(Type.inter(15, weight: .medium, .body)).foregroundStyle(Praxis.ink)
                                Text(rejection.reason.prefix(1).uppercased() + rejection.reason.dropFirst())
                                    .font(Type.inter(13, .footnote)).foregroundStyle(Praxis.secondaryInk)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }
    }

    private func read() {
        // Pasting from Notes or a chat app often brings curly quotes.
        let normalized = text
            .replacingOccurrences(of: "\u{201C}", with: "\"").replacingOccurrences(of: "\u{201D}", with: "\"")
            .replacingOccurrences(of: "\u{201E}", with: "\"")
            .replacingOccurrences(of: "\u{2018}", with: "'").replacingOccurrences(of: "\u{2019}", with: "'")
        do {
            let parsed = try ConnectorLibrary.candidates(config: normalized)
            withAnimation(Motion.reveal) {
                result = parsed
                error = nil
            }
            store.haptics.fire(parsed.candidates.isEmpty ? .warning : .success)
        } catch {
            withAnimation(Motion.reveal) {
                result = nil
                self.error = error.localizedDescription
            }
            store.haptics.fire(.warning)
        }
    }
}

/// A candidate's name, address and what it still needs.
struct CandidateRow: View {
    let candidate: MCPInstallCandidate

    var body: some View {
        HStack(spacing: 10) {
            IntegrationAvatar(monogram: String(candidate.name.prefix(1)).uppercased())
            VStack(alignment: .leading, spacing: 2) {
                Text(candidate.name).font(Type.inter(15, weight: .semibold, .body)).foregroundStyle(Praxis.ink)
                Text(candidate.urlTemplate).font(Type.mono(11, .caption2)).foregroundStyle(Praxis.mutedInk).lineLimit(1)
                if !candidate.inputs.isEmpty {
                    Text("Needs: " + candidate.inputs.map(\.key).joined(separator: ", "))
                        .font(Type.inter(12, .caption)).foregroundStyle(Praxis.secondaryInk).lineLimit(1)
                }
            }
            Spacer()
            LucideIcon(name: "chevron-right", size: 14).foregroundStyle(Praxis.mutedInk)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(minHeight: 56)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

// MARK: Registry

/// The official MCP registry, remote-capable entries only (the client
/// drops packages-only ones). Pages are filtered client-side, so a page
/// can come back empty while more exist: keep paging on the cursor.
struct ConnectorRegistryScreen: View {
    @Binding var path: [SettingsSheet.Route]
    @State private var query = ""
    @State private var entries: [MCPRegistryEntry] = []
    @State private var cursor: String?
    @State private var loading = false
    @State private var error: String?
    @State private var choosing: MCPRegistryEntry?

    private let client = MCPRegistryClient()

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                if let error {
                    Text(error).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.destructive).padding(.horizontal, 4)
                }
                if entries.isEmpty && !loading && error == nil {
                    Text(query.isEmpty ? "No servers found." : "No remote servers match “\(query)”.")
                        .font(Type.inter(14, .subheadline)).foregroundStyle(Praxis.secondaryInk).padding(.horizontal, 4)
                }
                if !entries.isEmpty {
                    SettingsCard {
                        ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                            if index > 0 { SettingsDivider() }
                            Button { pick(entry) } label: { entryRow(entry) }
                                .buttonStyle(PressHighlightStyle(cornerRadius: 18))
                        }
                    }
                }
                if loading {
                    ProgressView().frame(maxWidth: .infinity).padding()
                } else if cursor != nil {
                    Button("Load more") { Task { await load(reset: false) } }
                        .buttonStyle(.praxisText)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                }
                Text("From registry.modelcontextprotocol.io. Listed servers aren't reviewed by Praxis; check a server before trusting it.")
                    .font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk).padding(.horizontal, 4)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .scrollDismissesKeyboard(.interactively)
        .scrollEdgeEffectStyle(.soft, for: .top)
        .background(Praxis.canvas)
        .navigationTitle("MCP registry")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search servers")
        .task(id: query) {
            // Debounce typing; the task is cancelled by the next keystroke.
            if !query.isEmpty { try? await Task.sleep(for: .milliseconds(350)) }
            guard !Task.isCancelled else { return }
            await load(reset: true)
        }
        .confirmationDialog("Which address?", isPresented: Binding(get: { choosing != nil }, set: { if !$0 { choosing = nil } }),
                            titleVisibility: .visible, presenting: choosing) { entry in
            ForEach(Array(entry.remotes.enumerated()), id: \.offset) { _, remote in
                Button(remote.urlTemplate) {
                    path.append(.installConnector(entry.candidate(for: remote), values: [:]))
                }
            }
        }
    }

    private func entryRow(_ entry: MCPRegistryEntry) -> some View {
        HStack(alignment: .top, spacing: 10) {
            IntegrationAvatar(monogram: String(entry.displayName.prefix(1)).uppercased()).padding(.top, 3)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.displayName).font(Type.inter(15, weight: .semibold, .body)).foregroundStyle(Praxis.ink)
                if !entry.description.isEmpty {
                    Text(entry.description).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.secondaryInk).lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
                Text(entry.name).font(Type.mono(11, .caption2)).foregroundStyle(Praxis.mutedInk).lineLimit(1)
            }
            Spacer(minLength: 0)
            LucideIcon(name: "chevron-right", size: 14).foregroundStyle(Praxis.mutedInk).padding(.top, 3)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private func pick(_ entry: MCPRegistryEntry) {
        if entry.remotes.count == 1, let remote = entry.remotes.first {
            path.append(.installConnector(entry.candidate(for: remote), values: [:]))
        } else {
            choosing = entry
        }
    }

    /// Fetches until something shows (or pages run out), at most a few
    /// pages per call.
    private func load(reset: Bool) async {
        if reset {
            entries = []
            cursor = nil
        }
        loading = true
        error = nil
        defer { loading = false }
        var next = reset ? nil : cursor
        var fetched = 0
        let target = entries.count + 20
        repeat {
            do {
                let page = try await client.list(search: query.isEmpty ? nil : query, cursor: next)
                guard !Task.isCancelled else { return }
                let known = Set(entries.map(\.id))
                entries += page.entries.filter { !known.contains($0.id) }
                next = page.nextCursor
                fetched += 1
            } catch {
                if !Task.isCancelled { self.error = "Couldn't load the registry: \(error.localizedDescription)" }
                return
            }
        } while next != nil && fetched < 4 && entries.count < target
        cursor = next
    }
}

// MARK: Install and review

/// Fills in a candidate's inputs, installs it provisionally (off), then
/// connects: signing in or asking for a token if the server wants one,
/// and listing the tools for review. Only "Add connector" turns it on;
/// leaving any other way removes it again.
struct InstallConnectorScreen: View {
    let library: ConnectorLibrary
    let initial: MCPInstallCandidate
    let prefilled: [String: String]
    @Binding var path: [SettingsSheet.Route]
    @Environment(ChatStore.self) private var store

    @State private var name: String
    @State private var values: [String: String] = [:]
    @State private var phase: Phase = .inputs
    @State private var installedID: String?
    @State private var confirmed = false
    @State private var trusted = false
    @State private var error: String?
    // Credentials the server asked for after connecting.
    @State private var token = ""
    @State private var tokenHeader = "Authorization"
    @State private var clientID = ""
    @State private var clientSecret = ""
    @State private var redirectURI = ""
    @State private var scopes = ""
    /// The review step's optional sign-in form is open.
    @State private var showsSignInSetup = false

    enum Phase: Equatable {
        case inputs
        case working(String)
        case needsAuth(MCPAuthRequirement)
        case review([MCPToolDefinition])
        case failed(String)
    }

    init(library: ConnectorLibrary, candidate: MCPInstallCandidate, prefilled: [String: String],
         path: Binding<[SettingsSheet.Route]>) {
        self.library = library
        self.initial = candidate
        self.prefilled = prefilled
        _path = path
        _name = State(initialValue: candidate.name)
    }

    /// Inputs the earlier screen didn't already supply.
    private var openInputs: [MCPInstallInput] { initial.inputs.filter { prefilled[$0.key] == nil } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header
                switch phase {
                case .inputs: inputsSection
                case .working(let label): working(label)
                case .needsAuth(let requirement): authSection(requirement)
                case .review(let tools): reviewSection(tools)
                case .failed(let message): failedSection(message)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .animation(Motion.reflow, value: phase)
        }
        .scrollDismissesKeyboard(.interactively)
        .scrollEdgeEffectStyle(.soft, for: .top)
        .background(Praxis.canvas)
        .navigationTitle("Add connector")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            for input in initial.inputs where values[input.key] == nil {
                values[input.key] = prefilled[input.key] ?? input.defaultValue ?? ""
            }
        }
        // Back out before confirming: the provisional install goes away.
        .onDisappear {
            guard !confirmed, let id = installedID else { return }
            installedID = nil
            Task { await library.remove(id) }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 10) {
                IntegrationAvatar(monogram: String(name.prefix(1)).uppercased())
                Text(name.isEmpty ? initial.name : name).font(Type.inter(17, weight: .semibold, .headline)).foregroundStyle(Praxis.ink)
            }
            Text(initial.urlTemplate).font(Type.mono(12, .footnote)).foregroundStyle(Praxis.secondaryInk).textSelection(.enabled)
            if initial.note == "mcp-remote" {
                Text("Imported from an mcp-remote entry: Praxis connects to the server directly, nothing runs on this iPhone.")
                    .font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: Inputs

    private var inputsSection: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 8) {
                SettingsSectionTitle("Name")
                SettingsCard { SettingsField(title: "Connector name", text: $name, placeholder: initial.name) }
            }
            if !openInputs.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    SettingsSectionTitle("Details")
                    SettingsCard {
                        ForEach(Array(openInputs.enumerated()), id: \.element.key) { index, input in
                            if index > 0 { SettingsDivider() }
                            inputRow(input)
                        }
                    }
                }
            }
            if let error {
                Text(error).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.destructive).padding(.horizontal, 4)
                    .fixedSize(horizontal: false, vertical: true)
            }
            SettingsActionButton(title: "Connect", prominent: true, action: install)
        }
    }

    @ViewBuilder
    private func inputRow(_ input: MCPInstallInput) -> some View {
        let binding = Binding(get: { values[input.key] ?? "" }, set: { values[input.key] = $0 })
        let title = Self.title(for: input) + (input.isRequired ? "" : " (optional)")
        VStack(alignment: .leading, spacing: 4) {
            if !input.choices.isEmpty {
                HStack {
                    Text(title).font(Type.inter(15, .body)).foregroundStyle(Praxis.ink)
                    Spacer()
                    Picker(title, selection: binding) {
                        Text("Choose").tag("")
                        ForEach(input.choices, id: \.self) { Text($0).tag($0) }
                    }
                    .tint(Praxis.secondaryInk)
                }
            } else {
                Text(title).font(Type.inter(12, weight: .medium, .caption)).foregroundStyle(Praxis.mutedInk)
                Group {
                    if input.isSecret {
                        SecureField("Kept in the Keychain", text: binding)
                    } else {
                        TextField(input.defaultValue ?? "", text: binding)
                    }
                }
                .font(Type.mono(14, .body))
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .accessibilityLabel(Self.title(for: input))
            }
            if let description = input.description, !description.isEmpty {
                Text(description).font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private static func title(for input: MCPInstallInput) -> String {
        switch input.location {
        case .url: return input.key
        case .header(let header): return input.key == header ? header : "\(input.key) (\(header) header)"
        }
    }

    // MARK: Connecting

    private func working(_ label: String) -> some View {
        HStack(spacing: 10) {
            ProgressView()
            Text(label).font(Type.inter(15, .body)).foregroundStyle(Praxis.secondaryInk)
        }
        .padding(.vertical, 20)
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private func authSection(_ requirement: MCPAuthRequirement) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(requirement.message).font(Type.inter(15, .body)).foregroundStyle(Praxis.secondaryInk)
                .fixedSize(horizontal: false, vertical: true)
            switch requirement {
            case .oauthAutomatic(let issuer):
                SettingsActionButton(title: "Sign in with \(URL(string: issuer)?.host() ?? issuer)", prominent: true) {
                    Task { await signIn(automatic: true) }
                }
            case .oauthNeedsClientCredentials(let issuer):
                manualClientForm(issuer: issuer)
            case .tokenHeader:
                SettingsCard {
                    SettingsField(title: "Header", text: $tokenHeader, placeholder: "Authorization", monospaced: true)
                    SettingsDivider()
                    VStack(alignment: .leading, spacing: 4) {
                        Text(tokenHeader.caseInsensitiveCompare("Authorization") == .orderedSame ? "Token (sent as Bearer)" : "Value")
                            .font(Type.inter(12, weight: .medium, .caption)).foregroundStyle(Praxis.mutedInk)
                        SecureField("Kept in the Keychain", text: $token)
                            .font(Type.mono(14, .body))
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .accessibilityLabel("Token")
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                }
                SettingsActionButton(title: "Save and connect", prominent: true) { Task { await saveToken() } }
                    .disabled(token.trimmingCharacters(in: .whitespaces).isEmpty)
            case .unsupported, .none:
                EmptyView()
            }
            if let error {
                Text(error).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.destructive)
                    .fixedSize(horizontal: false, vertical: true)
            }
            SettingsActionButton(title: "Cancel", role: .destructive) { cancel() }
        }
    }

    private func manualClientForm(issuer: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            ManualOAuthFields(clientID: $clientID, clientSecret: $clientSecret, redirectURI: $redirectURI, scopes: $scopes,
                              issuer: issuer, advertisedScopes: installedID.flatMap { library.signInOffers[$0]?.scopes } ?? [],
                              recommendedScopes: installedID.flatMap { library.signInOffers[$0]?.recommendedScopes } ?? [])
            SettingsActionButton(title: "Save and sign in", prominent: true) { Task { await saveClientAndSignIn() } }
                .disabled(clientID.trimmingCharacters(in: .whitespaces).isEmpty)
        }
    }

    /// The server answered without credentials but advertises sign-in
    /// (e.g. Gmail: tools list anonymously, calls need a Google account).
    @ViewBuilder
    private var signInOffer: some View {
        if let id = installedID, let need = library.signInNeed(id), need.isOAuth {
            let host = ConnectorDetailScreen.host(of: need) ?? "its provider"
            VStack(alignment: .leading, spacing: 10) {
                SettingsSectionTitle("Sign-in available")
                Text("\(name) answered without signing in, but it supports signing in with \(host). Tools that read or change your data will likely fail until you do. You can also sign in later from the connector's settings or from a chat.")
                    .font(Type.inter(13, .footnote)).foregroundStyle(Praxis.secondaryInk).padding(.horizontal, 4)
                    .fixedSize(horizontal: false, vertical: true)
                switch need {
                case .oauthAutomatic:
                    SettingsActionButton(title: "Sign in with \(host)", prominent: true) { Task { await signIn(automatic: true) } }
                case .oauthNeedsClientCredentials(let issuer):
                    if showsSignInSetup {
                        manualClientForm(issuer: issuer)
                    } else {
                        SettingsActionButton(title: "Set up sign-in", prominent: true) {
                            withAnimation(Motion.reflow) { showsSignInSetup = true }
                        }
                    }
                default:
                    EmptyView()
                }
                if let error {
                    Text(error).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.destructive)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func reviewSection(_ tools: [MCPToolDefinition]) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            signInOffer
            VStack(alignment: .leading, spacing: 8) {
                SettingsSectionTitle(tools.count == 1 ? "Review its tool" : "Review its \(tools.count) tools")
                Text("The agent will be able to call these. Check they're what you expect before adding the connector.")
                    .font(Type.inter(13, .footnote)).foregroundStyle(Praxis.secondaryInk).padding(.horizontal, 4)
                    .fixedSize(horizontal: false, vertical: true)
                ToolList(tools: tools)
            }
            VStack(alignment: .leading, spacing: 8) {
                SettingsCard {
                    Toggle(isOn: $trusted) {
                        Text("Trust this server").font(Type.inter(15, .body)).foregroundStyle(Praxis.ink)
                    }
                    .tint(Praxis.ink)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 50)
                    .accessibilityLabel("Trust this server")
                }
                Text(TrustExplanation.text).font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk).padding(.horizontal, 4)
                    .fixedSize(horizontal: false, vertical: true)
            }
            SettingsActionButton(title: "Add connector", prominent: true) { Task { await confirm() } }
            SettingsActionButton(title: "Cancel") { cancel() }
        }
    }

    private func failedSection(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Couldn't connect").font(Type.inter(15, weight: .semibold, .body)).foregroundStyle(Praxis.ink)
            Text(message).font(Type.inter(14, .subheadline)).foregroundStyle(Praxis.secondaryInk)
                .fixedSize(horizontal: false, vertical: true)
            SettingsActionButton(title: "Try again", prominent: true) { Task { await connect() } }
            SettingsActionButton(title: "Edit details") {
                Task {
                    if let id = installedID { await library.remove(id) }
                    installedID = nil
                    phase = .inputs
                }
            }
            SettingsActionButton(title: "Cancel", role: .destructive) { cancel() }
        }
    }

    // MARK: Actions

    private func install() {
        var candidate = initial
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        if !trimmed.isEmpty { candidate.name = trimmed }
        var filled = values.filter { !$0.value.trimmingCharacters(in: .whitespaces).isEmpty }
        filled.merge(prefilled) { current, _ in current }
        do {
            let config = try library.install(candidate, values: filled, enabled: false)
            installedID = config.id
            error = nil
        } catch {
            withAnimation(Motion.reflow) { self.error = error.localizedDescription }
            store.haptics.fire(.warning)
            return
        }
        Task { await connect() }
    }

    private func connect() async {
        guard let id = installedID else { return }
        phase = .working("Connecting…")
        error = nil
        do {
            let tools = try await library.review(id)
            phase = .review(tools)
            store.haptics.fire(.success)
        } catch {
            if let requirement = library.authRequirements[id], requirement != .none {
                phase = .needsAuth(requirement)
            } else {
                phase = .failed(error.localizedDescription)
            }
            store.haptics.fire(.warning)
        }
    }

    private func signIn(automatic: Bool) async {
        guard let id = installedID else { return }
        if automatic { await library.useAutomaticOAuth(id) }
        phase = .working("Signing in…")
        do {
            try await library.signIn(id)
            await connect()
        } catch {
            // Optional sign-in from the review step: back to the review.
            if let tools = library.tools[id], library.authRequirements[id] == nil {
                phase = .review(tools)
            } else {
                let requirement = library.authRequirements[id]
                phase = requirement.map { .needsAuth($0) } ?? .failed(error.localizedDescription)
            }
            if !(error is CancellationError) { self.error = error.localizedDescription }
        }
    }

    private func saveClientAndSignIn() async {
        guard let id = installedID else { return }
        do {
            try await library.setManualOAuth(id, clientID: clientID, clientSecret: clientSecret,
                                             redirectURI: redirectURI, scopes: OAuthClientGuide.scopes(from: scopes))
        } catch {
            self.error = error.localizedDescription
            return
        }
        await signIn(automatic: false)
    }

    private func saveToken() async {
        guard let id = installedID, let server = library.server(id) else { return }
        let header = tokenHeader.trimmingCharacters(in: .whitespaces).isEmpty ? "Authorization" : tokenHeader
        let raw = token.trimmingCharacters(in: .whitespacesAndNewlines)
        let value = header.caseInsensitiveCompare("Authorization") == .orderedSame && !raw.lowercased().hasPrefix("bearer ")
            ? "Bearer \(raw)" : raw
        var edits = server.headers.filter { $0.name.caseInsensitiveCompare(header) != .orderedSame }.map { h -> HeaderEdit in
            switch h.value {
            case .plain(let v): return HeaderEdit(name: h.name, value: v, isSecret: false)
            case .secret: return HeaderEdit(name: h.name, value: nil, isSecret: true)
            }
        }
        edits.append(HeaderEdit(name: header, value: value, isSecret: true))
        do {
            try await library.setHeaders(id, edits)
            token = ""
        } catch {
            self.error = error.localizedDescription
            return
        }
        await connect()
    }

    private func confirm() async {
        guard let id = installedID else { return }
        confirmed = true
        await library.setTrusted(id, trusted)
        await library.setEnabled(id, true)
        store.haptics.fire(.success)
        path = [.connectors]
    }

    private func cancel() {
        if let id = installedID {
            installedID = nil
            Task { await library.remove(id) }
        }
        if !path.isEmpty { path.removeLast() }
    }
}
