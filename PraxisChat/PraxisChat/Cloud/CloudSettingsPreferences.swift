import SwiftUI

struct CloudSettingsImageReaderScreen: View {
    let services: CloudServices
    @State private var query = ""
    var body: some View {
        CloudSettingsPage(title: "Image reading model") {
            Text("When a chat model cannot see images, the cloud image-reading model can describe them. Allow sharing with its provider host in AI data sharing.")
                .font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk)
            SettingsCard {
                CloudSettingsToggle("Enable image reader", isOn: services.preferences?.vision.enabled ?? false) {
                    try await services.savePreferences(CloudCatalogPreferencesInput(vision: .init(enabled: $0)))
                }
            }
            if let selection = services.preferences?.vision, let modelID = selection.modelId {
                Text("Current: \(modelID) · \(services.providerName(selection.providerId ?? ""))")
                    .font(Type.inter(13, .footnote)).foregroundStyle(Praxis.secondaryInk)
            }
            Text("Choose a model with image support").font(Type.inter(13, weight: .semibold, .footnote))
            ForEach(services.models.filter(\.capabilities.vision), id: \.selectionID) { model in
                CloudSettingsAction(model.displayName + " · " + services.providerName(model.providerId)) {
                    try await services.savePreferences(CloudCatalogPreferencesInput(vision: .init(providerId: model.providerId, modelId: model.id, enabled: true)))
                }
            }
            if services.loadingModels { ProgressView() }
            if services.nextModelCursor != nil { CloudSettingsAction("Load more models") { try await services.loadMoreModels() } }
            if let error = services.lastError { CloudSettingsErrorText(message: error) }
        }
        .searchable(text: $query, prompt: "Search image-reading models")
        .task(id: query) {
            do { try await Task.sleep(for: .milliseconds(250)); try await services.searchModels(query: query) }
            catch is CancellationError { } catch { }
        }
    }
}

struct CloudSettingsVoiceScreen: View {
    let services: CloudServices
    @State private var model = ""
    @State private var language = ""
    @State private var key = ""
    @State private var loaded = false
    @State private var saved = false
    var body: some View {
        CloudSettingsPage(title: "Voice input") {
            SettingsCard {
                HStack {
                    Text("Cloud transcription").font(Type.inter(15, .body))
                    Spacer()
                    Text(services.preferences?.voice.configured == true ? "Configured" : "Not configured").font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk)
                }.padding(14).accessibilityIdentifier("cloudVoiceStatus")
                SettingsDivider()
                SettingsField(title: "Speech model", text: $model, placeholder: "whisper-large-v3-turbo", monospaced: true)
                SettingsDivider()
                SettingsField(title: "Language", text: $language, placeholder: "Auto (or ISO language code)")
                SettingsDivider()
                SecureField("Groq API key (optional replacement)", text: $key)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().padding(14).accessibilityLabel("Cloud voice API key")
            }
            Text("Audio is transcribed by your cloud server. Keys are sent once to the server and are never saved or read from this device. Leaving the key empty keeps the server's configuration.")
                .font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk)
            CloudSettingsAction("Save voice settings", identifier: "cloudSaveVoice") {
                defer { key = "" }
                let typedKey = key.trimmingCharacters(in: .whitespacesAndNewlines)
                try await services.savePreferences(CloudCatalogPreferencesInput(voice: .init(
                    model: model.trimmingCharacters(in: .whitespacesAndNewlines),
                    language: language.trimmingCharacters(in: .whitespacesAndNewlines), apiKey: typedKey.isEmpty ? nil : typedKey)))
                saved = true
            }.disabled(model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            if saved { Text("Voice settings saved.").font(Type.inter(13, .footnote)).foregroundStyle(Praxis.secondaryInk) }
            NavigationLink { CloudSettingsConsentScreen(services: services) } label: {
                CloudSettingsRow(title: "AI data sharing", symbol: "hand.raised")
            }.buttonStyle(PressHighlightStyle())
        }
        .onAppear {
            guard !loaded else { return }; loaded = true
            model = services.preferences?.voice.model ?? "whisper-large-v3-turbo"
            language = services.preferences?.voice.language ?? ""
        }
        .onDisappear { key = "" }
    }
}
