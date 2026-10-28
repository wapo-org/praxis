import SwiftUI

/// Asked before the first live send to a provider host (App Review
/// 5.1.2(i)): who receives the data and what it is. Nothing has been
/// sent while this shows; Don't Allow (or swiping away) puts the message
/// back in the composer.
struct ConsentSheet: View {
    let request: ConsentRequest
    @Environment(ChatStore.self) private var store

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(isTranscribe ? "Share this voice recording with \(request.host)?" : "Share this chat with \(request.host)?")
                            .font(Type.inter(22, weight: .semibold, .title2))
                            .foregroundStyle(Praxis.ink)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityAddTraits(.isHeader)
                            .accessibilityIdentifier("consentTitle")
                        Text(isTranscribe
                            ? "To transcribe, Praxis sends your voice recording to \(request.providerName) at \(request.host). It goes straight from this iPhone to that server; Praxis has no server of its own in between."
                            : "To answer, Praxis sends your chat to \(request.providerName) at \(request.host). It goes straight from this iPhone to that server; Praxis has no server of its own in between.")
                            .font(Type.inter(15, .body))
                            .foregroundStyle(Praxis.secondaryInk)
                            .lineSpacing(4)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        SettingsSectionTitle("What's sent")
                        SettingsCard {
                            if isTranscribe {
                                item("waveform", "Voice recordings", "The audio you recorded, to turn into text. Nothing else from your chats.")
                            } else {
                                item("text.bubble", "Your messages", "This chat's messages so far, and each new one.")
                                SettingsDivider()
                                item("paperclip", "Attachments", "Photos and files you add to the chat.")
                                SettingsDivider()
                                item("wrench.and.screwdriver", "Tool results", "What the agent's tools return, like web pages it reads or code output.")
                                SettingsDivider()
                                item("link", "Connector data", connectorDetail)
                            }
                        }
                    }

                    Text("\(request.providerName)'s own terms and privacy policy apply to what it receives. You can withdraw this in Settings → AI data sharing; Praxis then asks again before sending.")
                        .font(Type.inter(12, .caption))
                        .foregroundStyle(Praxis.mutedInk)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 4)

                    VStack(spacing: 10) {
                        Button { store.resolveConsent(allow: true) } label: {
                            PraxisButtonLabel(isTranscribe ? "Allow and transcribe" : "Allow and send")
                        }
                        .buttonStyle(.praxisPrimary(fillsWidth: true))
                        .accessibilityLabel(isTranscribe ? "Allow and transcribe" : "Allow and send")

                        Button { store.resolveConsent(allow: false) } label: {
                            PraxisButtonLabel("Don't allow")
                        }
                        .buttonStyle(.praxisSecondary(fillsWidth: true))
                        .accessibilityLabel("Don't allow")
                    }
                }
                .padding(20)
            }
            .scrollEdgeEffectStyle(.soft, for: .top)
            .background(Praxis.canvas)
            .navigationTitle("AI data sharing")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.large])
        // Swiped away: same as Don't Allow (a no-op once answered).
        .onDisappear {
            if store.pendingConsent?.id == request.id { store.resolveConsent(allow: false) }
        }
    }

    /// A held voice transcription (voice-groq): different copy, same sheet.
    private var isTranscribe: Bool {
        if case .transcribe = request.action { return true }
        return false
    }

    private var connectorDetail: String {
        guard !request.connectorNames.isEmpty else {
            return "What connectors you turn on return to the agent. None are on in this chat."
        }
        return "What the agent reads from connectors on in this chat: \(ListFormatter.localizedString(byJoining: request.connectorNames))."
    }

    private func item(_ symbol: String, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 14))
                .foregroundStyle(Praxis.mutedInk)
                .frame(width: 20)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(Type.inter(15, weight: .medium, .body)).foregroundStyle(Praxis.ink)
                Text(detail).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.secondaryInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
    }
}
