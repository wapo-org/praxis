import SwiftUI

struct CloudSettingsProviderEditor: View {
    @Environment(\.dismiss) private var dismiss
    let services: CloudServices
    var provider: CloudCatalogProvider?
    @State private var name = ""
    @State private var baseURL = ""
    @State private var flavor = "openAIChat"
    @State private var apiKey = ""
    @State private var defaultModel = ""
    @State private var replaceHeaders = false
    @State private var headers: [CloudSettingsHeaderDraft] = []
    @State private var capabilities = CloudCatalogCapabilities()
    @State private var loaded = false
    
    @State private var probeMessage: String?

    var body: some View {
        CloudSettingsPage(title: provider?.name ?? "Add provider") {
            SettingsSectionTitle("Connection")
            SettingsCard {
                SettingsField(title: "Name", text: $name, placeholder: "My provider")
                SettingsDivider()
                Picker("API format", selection: $flavor) {
                    Text("OpenAI Chat compatible").tag("openAIChat")
                    Text("OpenAI Responses compatible").tag("openAIResponses")
                    Text("Anthropic compatible").tag("anthropicMessages")
                }.font(Type.inter(14, .body)).tint(Praxis.ink).padding(.horizontal, 14).frame(minHeight: 48)
                SettingsDivider()
                SettingsField(title: "Base URL", text: $baseURL, placeholder: "https://api.example.com/v1", keyboard: .URL, monospaced: true)
                SettingsDivider()
                VStack(alignment: .leading, spacing: 6) {
                    Text("API key").font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk)
                    SecureField(provider?.maskedKey.isEmpty == false ? "Leave empty to keep saved key" : "API key", text: $apiKey)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityLabel("API key").accessibilityIdentifier("cloudProviderKey")
                    if let mask = provider?.maskedKey, !mask.isEmpty {
                        Text("Saved: \(mask)").font(Type.mono(12, .caption)).foregroundStyle(Praxis.mutedInk)
                    }
                }.padding(14)
            }
            SettingsSectionTitle("Model")
            SettingsCard { SettingsField(title: "Default model ID", text: $defaultModel, placeholder: "Optional model ID", monospaced: true) }
            CloudSettingsHeaderFields(replace: $replaceHeaders, headers: $headers, savedNames: provider?.headerNames ?? [])
            Text("Your cloud server encrypts this key. Praxis does not save provider keys on this device.")
                .font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk)
            SettingsSectionTitle("Capabilities")
            SettingsCard {
                ForEach(Array(Self.capabilities.enumerated()), id: \.offset) { index, row in
                    if index > 0 { SettingsDivider() }
                    Toggle(row.0, isOn: Binding(get: { capabilities[keyPath: row.1] }, set: { capabilities[keyPath: row.1] = $0 }))
                        .font(Type.inter(14, .body)).tint(Praxis.ink).padding(.horizontal, 14).frame(minHeight: 46)
                }
            }
            CloudSettingsAction("Save provider", identifier: "cloudSaveProvider") {
                let typed = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
                defer { apiKey = ""; headers = [] }
                _ = try await services.saveProvider(id: provider?.id, input: CloudCatalogProviderInput(
                    name: name.trimmingCharacters(in: .whitespacesAndNewlines), flavor: flavor,
                    baseUrl: baseURL.trimmingCharacters(in: .whitespacesAndNewlines),
                    apiKey: typed.isEmpty ? nil : typed, capabilities: capabilities,
                    extraHeaders: replaceHeaders ? try CloudSettingsHeaderDraft.values(headers) : nil,
                    defaultModel: defaultModel.trimmingCharacters(in: .whitespacesAndNewlines)))
                dismiss()
            }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || baseURL.isEmpty)
            if let provider {
                CloudSettingsAction("Test connection") {
                    probeMessage = nil
                    let result = try await services.testProvider(provider.id, modelID: defaultModel.trimmingCharacters(in: .whitespacesAndNewlines))
                    probeMessage = result.summary
                    if result.ok, let probe = result.probe { capabilities = probe.applying(to: capabilities) }
                }
                .disabled(defaultModel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Text("Tests the saved connection using the model ID above. Probes can incur provider charges. Review the detected capabilities, then save to apply them.")
                    .font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk)
                if let probeMessage { Text(probeMessage).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.secondaryInk) }
                CloudSettingsAction("Refresh models") { try await services.refreshProviderModels(provider.id) }
                Button("Delete provider", role: .destructive) { deleting = true }.buttonStyle(.praxisText)
            }
        }
        .onAppear {
            guard !loaded else { return }; loaded = true
            if let provider { name = provider.name; baseURL = provider.baseUrl; flavor = provider.flavor; capabilities = provider.capabilities; defaultModel = provider.defaultModel ?? "" }
        }
        .onDisappear { apiKey = ""; headers = [] }
        .overlay(alignment: .bottom) {
            if deleting, let provider {
                SettingsCard {
                    CloudSettingsAction("Confirm delete", destructive: true) { try await services.deleteProvider(provider.id); dismiss() }.padding(14)
                    Button("Cancel") { deleting = false }.buttonStyle(.praxisText).padding(.bottom, 14)
                }.padding(16)
            }
        }
    }

    @State private var deleting = false
    private static let capabilities: [(String, WritableKeyPath<CloudCatalogCapabilities, Bool>)] = [
        ("Tool calling", \.tools), ("Parallel tool calls", \.parallelToolCalls), ("Images (vision)", \.vision),
        ("PDF documents", \.documents), ("Images in tool results", \.imagesInToolResults),
        ("Reasoning effort", \.reasoningEffort), ("Streams token usage", \.streamUsage),
        ("Prompt caching", \.explicitPromptCaching), ("Hosted web search", \.serverWebSearch),
        ("Mid-chat system messages", \.midConversationSystem), ("Server compaction", \.serverCompaction), ("Tool search", \.toolSearch),
    ]
}
