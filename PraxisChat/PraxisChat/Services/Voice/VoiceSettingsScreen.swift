import SwiftUI

/// Recovery-list destination for the Recordings row. voice-rec sets the real
/// list (from `VoiceRecordingViews`, needs its controller) at the app root;
/// the default is the correct empty state, so this screen compiles and tests
/// standalone on the voice-groq branch.
struct VoiceRecordingsListKey: EnvironmentKey {
    static let defaultValue: AnyView = AnyView(VoiceRecordingsEmptyView())
}

extension EnvironmentValues {
    var voiceRecordingsList: AnyView {
        get { self[VoiceRecordingsListKey.self] }
        set { self[VoiceRecordingsListKey.self] = newValue }
    }
}

struct VoiceRecordingsEmptyView: View {
    var body: some View {
        ScrollView {
            Text("No recordings. Finished recordings that still need transcribing — or failed ones you can retry — show up here.")
                .font(Type.inter(14, .subheadline))
                .foregroundStyle(Praxis.secondaryInk)
                .lineSpacing(4)
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
                .fixedSize(horizontal: false, vertical: true)
        }
        .background(Praxis.canvas)
        .navigationTitle("Recordings")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Settings → Voice input: Groq API key, speech-model picker, language, and
/// the recordings row. Reached from `SettingsSheet` with a one-line
/// navigation row; creates no dependency on voice-rec's files (the
/// Recordings destination arrives via the environment).
struct VoiceSettingsScreen: View {
    @Bindable var settings: GroqVoiceSettings
    @Environment(\.voiceRecordingsList) private var recordingsList
    @State private var keyText = ""
    @State private var showKey = false
    @State private var manualModelID = ""
    @State private var showManualEntry = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                keySection
                modelSection
                languageSection
                recordingsSection
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Praxis.canvas)
        .navigationTitle("Voice input")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            // Refresh-on-open when stale (> 24 h), with a manual retry below.
            if settings.modelListIsStale { await settings.refreshModels() }
        }
    }

    // MARK: API key

    private var keySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsSectionTitle("Groq API key")
            SettingsCard {
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        if showKey {
                            TextField(keyPlaceholder, text: $keyText)
                                .font(Type.mono(14, .body))
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .accessibilityLabel("Groq API key")
                        } else {
                            SecureField(keyPlaceholder, text: $keyText)
                                .font(Type.mono(14, .body))
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .textContentType(.password)
                                .accessibilityLabel("Groq API key")
                        }
                        Button {
                            showKey.toggle()
                        } label: {
                            Image(systemName: showKey ? "eye.slash" : "eye")
                                .font(.system(size: 15))
                                .foregroundStyle(Praxis.mutedInk)
                                .frame(width: 32, height: 32)
                        }
                        .accessibilityLabel(showKey ? "Hide API key" : "Show API key")
                    }
                    if settings.hasKey, keyText.isEmpty {
                        Button("Remove saved key", role: .destructive) {
                            settings.removeKey()
                        }
                        .buttonStyle(.praxisText)
                        .padding(.top, 2)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
            }
            Button(action: { settings.saveKey(keyText); keyText = "" }) {
                PraxisButtonLabel("Save API key")
            }
            .buttonStyle(.praxisSecondary(fillsWidth: true))
            .disabled(keyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel("Save API key")
            Text("Kept in this device's Keychain and only sent to Groq. You can record without a key and transcribe later.")
                .font(Type.inter(12, .caption))
                .foregroundStyle(Praxis.mutedInk)
                .padding(.horizontal, 4)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var keyPlaceholder: String {
        settings.hasKey ? "Saved — type to replace" : "gsk_…"
    }

    // MARK: Model

    private var modelSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsSectionTitle("Speech model")
            SettingsCard {
                if settings.displayModels.isEmpty {
                    Text("No speech models listed yet.")
                        .font(Type.inter(14, .subheadline))
                        .foregroundStyle(Praxis.secondaryInk)
                        .padding(.horizontal, 14)
                        .frame(minHeight: 50, alignment: .leading)
                } else {
                    ForEach(settings.displayModels, id: \.self) { id in
                        if id != settings.displayModels.first { SettingsDivider() }
                        Button {
                            settings.selectModel(id)
                        } label: {
                            HStack(spacing: 10) {
                                Text(id)
                                    .font(Type.mono(14, .body))
                                    .foregroundStyle(Praxis.ink)
                                    .lineLimit(1)
                                Spacer()
                                if id == settings.selectedModelID {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 14, weight: .semibold))
                                        .foregroundStyle(Praxis.ink)
                                }
                            }
                            .padding(.horizontal, 14)
                            .frame(minHeight: 50)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(PressHighlightStyle(cornerRadius: 18))
                        .accessibilityLabel("Use model \(id)")
                        .accessibilityValue(id == settings.selectedModelID ? "selected" : "")
                    }
                }
                SettingsDivider()
                Button {
                    showManualEntry.toggle()
                } label: {
                    HStack(spacing: 10) {
                        Text("Use model id…")
                            .font(Type.inter(15, .body))
                            .foregroundStyle(Praxis.secondaryInk)
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Praxis.mutedInk)
                    }
                    .padding(.horizontal, 14)
                    .frame(minHeight: 50)
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressHighlightStyle(cornerRadius: 18))
                .accessibilityLabel("Use model id")
                if showManualEntry {
                    SettingsDivider()
                    HStack(spacing: 8) {
                        TextField("whisper-large-v3-turbo", text: $manualModelID)
                            .font(Type.mono(14, .body))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .accessibilityLabel("Model id")
                        Button("Use") {
                            settings.selectModel(manualModelID)
                            manualModelID = ""
                            showManualEntry = false
                        }
                        .buttonStyle(.praxisSecondary())
                        .disabled(manualModelID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityLabel("Use this model id")
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                }
            }
            Button {
                Task { await settings.refreshModels() }
            } label: {
                PraxisButtonLabel(settings.refreshing ? "Loading models…" : "Reload models",
                                  working: settings.refreshing)
            }
            .buttonStyle(.praxisSecondary(fillsWidth: true))
            .disabled(settings.refreshing)
            .accessibilityLabel("Reload models")
            if let error = settings.lastRefreshError {
                Text(error)
                    .font(Type.inter(13, .footnote))
                    .foregroundStyle(Praxis.destructive)
                    .padding(.horizontal, 4)
                    .fixedSize(horizontal: false, vertical: true)
            } else if settings.displayModels.isEmpty {
                Text("Add your key and reload to list Groq's speech models, or type a model id.")
                    .font(Type.inter(13, .footnote))
                    .foregroundStyle(Praxis.mutedInk)
                    .padding(.horizontal, 4)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: Language

    private var languageSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsSectionTitle("Language")
            SettingsCard {
                Menu {
                    ForEach(GroqVoiceSettings.supportedLanguages, id: \.name) { entry in
                        Button {
                            settings.setLanguage(entry.code)
                        } label: {
                            if entry.code == settings.language {
                                Label(entry.name, systemImage: "checkmark")
                            } else {
                                Text(entry.name)
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 10) {
                        Text("Audio language")
                            .font(Type.inter(15, .body))
                            .foregroundStyle(Praxis.ink)
                        Spacer()
                        Text(GroqVoiceSettings.languageName(for: settings.language))
                            .font(Type.inter(15, .body))
                            .foregroundStyle(Praxis.secondaryInk)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 11))
                            .foregroundStyle(Praxis.mutedInk)
                    }
                    .padding(.horizontal, 14)
                    .frame(minHeight: 50)
                    .contentShape(Rectangle())
                }
                .accessibilityLabel("Audio language, \(GroqVoiceSettings.languageName(for: settings.language))")
            }
            Text("Telling Groq the language improves accuracy and speed. Auto detects it.")
                .font(Type.inter(12, .caption))
                .foregroundStyle(Praxis.mutedInk)
                .padding(.horizontal, 4)
        }
    }

    // MARK: Recordings

    private var recordingsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsSectionTitle("Recordings")
            SettingsCard {
                NavigationLink {
                    recordingsList
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "waveform")
                            .font(.system(size: 14))
                            .foregroundStyle(Praxis.mutedInk)
                            .frame(width: 20)
                        Text("Recordings")
                            .font(Type.inter(15, .body))
                            .foregroundStyle(Praxis.ink)
                        Spacer()
                        LucideIcon(name: "chevron-right", size: 14).foregroundStyle(Praxis.mutedInk)
                    }
                    .padding(.horizontal, 14)
                    .frame(minHeight: 52)
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressHighlightStyle(cornerRadius: 18))
                .accessibilityLabel("Recordings")
            }
            Text("Unfinished or failed recordings wait here — Transcribe or Delete, never lost silently.")
                .font(Type.inter(12, .caption))
                .foregroundStyle(Praxis.mutedInk)
                .padding(.horizontal, 4)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
