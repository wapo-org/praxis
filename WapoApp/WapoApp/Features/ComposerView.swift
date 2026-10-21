import SwiftUI

/// Message composer: attach menu, dictation stub, send/stop states.
/// Mirrors the reference composer modules (`ClaudeComposer`,
/// `ChatInput/ChatInputMenuModel.swift` — names observed).
struct ComposerView: View {
    @Binding var draft: String
    var isStreaming: Bool
    var onSend: () -> Void
    var onStop: () -> Void
    @FocusState private var focused: Bool

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isStreaming
    }

    var body: some View {
        VStack(spacing: Tokens.s2) {
            HStack(alignment: .bottom, spacing: Tokens.s2) {
                Menu {
                    Button { } label: { Label("Take photo", systemImage: "camera") }
                    Button { } label: { Label("Add photo", systemImage: "photo") }
                    Button { } label: { Label("Add file", systemImage: "doc") }
                } label: {
                    AppIcon.addCircle.image(size: 24).foregroundStyle(.secondary)
                        .frame(width: 36, height: 36)
                }
                .accessibilityLabel("Add attachment")

                TextField("Message", text: $draft, axis: .vertical)
                    .font(Tokens.bodySans)
                    .lineLimit(1...6)
                    .focused($focused)
                    .padding(.vertical, Tokens.s2)

                if isStreaming {
                    Button(action: onStop) {
                        AppIcon.stop.image(size: 13)
                            .frame(width: 36, height: 36)
                            .background(Tokens.accent, in: Circle())
                            .foregroundStyle(Color.white)
                    }
                    .buttonStyle(HapticButtonStyle())
                    .accessibilityLabel("Stop generating")
                } else {
                    Button { } label: {
                        AppIcon.mic.image(size: 18).foregroundStyle(.secondary)
                            .frame(width: 36, height: 36)
                    }
                    .accessibilityLabel("Dictate")
                    Button(action: onSend) {
                        AppIcon.arrowUp.image(size: 15, weight: .semibold)
                            .frame(width: 36, height: 36)
                            .background(canSend ? Tokens.accent : Tokens.hairline, in: Circle())
                            .foregroundStyle(Color.white)
                    }
                    .buttonStyle(HapticButtonStyle())
                    .disabled(!canSend)
                    .accessibilityLabel("Send message")
                }
            }
            .padding(.horizontal, Tokens.s2)
            .padding(.vertical, Tokens.s1)
            .background(Tokens.surfaceRaised, in: RoundedRectangle(cornerRadius: 26))
            .overlay(RoundedRectangle(cornerRadius: 26).stroke(Tokens.hairline, lineWidth: 1))

            Text("Local API · \(APIClient.defaultBaseURL.absoluteString)")
                .font(.system(size: 11)).foregroundStyle(.secondary)
        }
        .padding(.horizontal, Tokens.s3)
        .padding(.top, Tokens.s2)
        .padding(.bottom, Tokens.s2)
        .background(Tokens.surface)
    }
}
