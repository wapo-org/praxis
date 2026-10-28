import SwiftUI
import AgentCore

/// Settings → Image reading model: the profile + model that looks at
/// images for chat models that can't (`look_at_image`). Any configured
/// provider works; its key stays in the Keychain. Picking a model on a
/// host that hasn't been allowed to receive chat data asks first.
struct ImageReaderScreen: View {
    let settings: ProviderSettings
    let consent: AIDataConsent
    @Environment(ChatStore.self) private var store
    @State private var profileID: UUID?
    @State private var query = ""
    @State private var pending: ImageReaderChoice?

    private var profile: ProviderProfile? {
        settings.profile(profileID ?? settings.imageReader?.profileID ?? settings.selectedProfileID ?? UUID())
            ?? settings.profiles.first
    }

    /// Models that take images first, then ones the list doesn't describe.
    private func candidates(_ profile: ProviderProfile) -> [ModelInfo] {
        guard profile.endpoint.capabilities.vision else { return [] }
        // Leaves out models known to be text-only: listed as such, or
        // turned down for images before (`markImagesUnsupported`).
        var models = settings.models(for: profile.id).filter {
            $0.supportsImages != false && settings.imageSupport(profileID: profile.id, model: $0.id) != .unsupported
        }
        if models.isEmpty, !profile.defaultModel.isEmpty { models = [ModelInfo(id: profile.defaultModel)] }
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        if !q.isEmpty { models = models.filter { $0.id.lowercased().contains(q) || $0.displayName.lowercased().contains(q) } }
        return models.filter { $0.supportsImages == true } + models.filter { $0.supportsImages == nil }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("When the chat model can't see images, Praxis doesn't send it the photo. The agent instead asks this model questions about the image — several times if it needs details — and gets text answers back.")
                    .font(Type.inter(14, .subheadline)).foregroundStyle(Praxis.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true).padding(.horizontal, 4)

                current

                if let pending { consentCard(pending) }

                if settings.profiles.isEmpty {
                    Text("Add a provider first.").font(Type.inter(14, .subheadline)).foregroundStyle(Praxis.secondaryInk)
                } else if let profile {
                    profilePicker
                    modelList(profile)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .background(Praxis.canvas)
        .navigationTitle("Image reading model")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search models")
        .task(id: profile?.id) {
            if let id = profile?.id, settings.models(for: id).isEmpty { await settings.refreshModels(for: id) }
        }
    }

    private var current: some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsSectionTitle("In use")
            SettingsCard {
                HStack(spacing: 10) {
                    Image(systemName: "eye").font(.system(size: 14)).foregroundStyle(Praxis.mutedInk).frame(width: 20)
                    Text(settings.imageReaderDisplayName ?? "Off").font(Type.inter(15, .body)).foregroundStyle(Praxis.ink)
                        .accessibilityIdentifier("imageReaderCurrent")
                    Spacer()
                    if settings.imageReader != nil {
                        Button("Turn off") {
                            store.haptics.fire(.selection)
                            settings.setImageReader(nil)
                        }
                        .buttonStyle(.praxisText)
                    }
                }
                .padding(.horizontal, 14).frame(minHeight: 52)
            }
            if let reader = settings.imageReader,
               settings.imageSupport(profileID: reader.profileID, model: reader.model) == .unsupported {
                Text("This model doesn't take images, so it can't read them. Pick one that does below.")
                    .font(Type.inter(13, .footnote)).foregroundStyle(Praxis.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true).padding(.horizontal, 4)
                    .accessibilityIdentifier("imageReaderCantSeeImages")
            }
        }
    }

    private var profilePicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(settings.profiles) { p in
                    let selected = p.id == profile?.id
                    Button {
                        store.haptics.fire(.selection)
                        profileID = p.id
                    } label: {
                        Text(p.name).font(Type.inter(14, weight: selected ? .semibold : .regular, .subheadline))
                            .foregroundStyle(selected ? Praxis.canvas : Praxis.ink)
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .background(selected ? Praxis.ink : Praxis.card, in: Capsule())
                            .overlay(Capsule().strokeBorder(Praxis.hairline, lineWidth: selected ? 0 : 1))
                    }
                    .buttonStyle(PressScaleStyle())
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
        }
    }

    @ViewBuilder
    private func modelList(_ profile: ProviderProfile) -> some View {
        let models = candidates(profile)
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                SettingsSectionTitle("Models that take images")
                Spacer()
                if settings.refreshingModels.contains(profile.id) { ProgressView().controlSize(.small) } else {
                    Button("Refresh") { Task { await settings.refreshModels(for: profile.id) } }
                        .buttonStyle(.praxisText(muted: true))
                }
            }
            if !profile.endpoint.capabilities.vision {
                Text("\(profile.name) is set up without image support (Settings → \(profile.name) → capabilities).")
                    .font(Type.inter(13, .footnote)).foregroundStyle(Praxis.secondaryInk).padding(.horizontal, 4)
            } else if models.isEmpty {
                Text(query.isEmpty ? "No models listed. Refresh, or set a default model for \(profile.name)." : "No models match.")
                    .font(Type.inter(13, .footnote)).foregroundStyle(Praxis.secondaryInk).padding(.horizontal, 4)
            } else {
                SettingsCard {
                    LazyVStack(spacing: 0) {
                        ForEach(models.prefix(300)) { model in
                            if model.id != models.first?.id { SettingsDivider() }
                            row(model, profile: profile)
                        }
                    }
                }
                .accessibilityIdentifier("imageReaderModels")
                if models.contains(where: { $0.supportsImages == nil }) {
                    Text("“Image support unknown”: the server doesn't say. Pick one you know reads images.")
                        .font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk).padding(.horizontal, 4)
                }
            }
        }
    }

    private func row(_ model: ModelInfo, profile: ProviderProfile) -> some View {
        let chosen = settings.imageReader == ImageReaderChoice(profileID: profile.id, model: model.id)
        return Button {
            choose(ImageReaderChoice(profileID: profile.id, model: model.id), profile: profile)
        } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.displayName).font(Type.inter(15, .body)).foregroundStyle(Praxis.ink).lineLimit(1)
                    Text(model.supportsImages == true ? model.id : "\(model.id) · Image support unknown")
                        .font(Type.mono(11, .caption2)).foregroundStyle(Praxis.mutedInk).lineLimit(1)
                }
                Spacer()
                if chosen { Image(systemName: "checkmark").font(.system(size: 13, weight: .semibold)).foregroundStyle(Praxis.ink) }
            }
            .padding(.horizontal, 14).padding(.vertical, 9).contentShape(Rectangle())
        }
        .buttonStyle(PressHighlightStyle(cornerRadius: 0))
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }

    private func choose(_ choice: ImageReaderChoice, profile: ProviderProfile) {
        store.haptics.fire(.selection)
        if consent.isGranted(baseURL: profile.endpoint.baseURL) {
            settings.setImageReader(choice)
            pending = nil
        } else {
            withAnimation(Motion.reflow) { pending = choice }
        }
    }

    private func consentCard(_ choice: ImageReaderChoice) -> some View {
        let profile = settings.profile(choice.profileID)
        let host = profile.map { AIDataConsent.host(of: $0.endpoint.baseURL) } ?? ""
        let name = profile?.name ?? host
        return SettingsCard {
            VStack(alignment: .leading, spacing: 10) {
                Text("Send images to \(host)?").font(Type.inter(15, weight: .semibold, .body)).foregroundStyle(Praxis.ink)
                Text("When the agent looks at a picture, Praxis sends that image and the agent's question to \(name) at \(host), straight from this iPhone. \(name)'s terms and privacy policy apply. You can withdraw this in Settings → AI data sharing.")
                    .font(Type.inter(13, .footnote)).foregroundStyle(Praxis.secondaryInk).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 10) {
                    SettingsActionButton(title: "Allow", prominent: true) {
                        consent.grant(host, providerName: name)
                        settings.setImageReader(choice)
                        withAnimation(Motion.reflow) { pending = nil }
                        store.haptics.fire(.success)
                    }
                    .accessibilityIdentifier("imageReaderAllow")
                    SettingsActionButton(title: "Cancel") { withAnimation(Motion.reflow) { pending = nil } }
                }
            }
            .padding(14)
        }
        .transition(.opacity)
    }
}
