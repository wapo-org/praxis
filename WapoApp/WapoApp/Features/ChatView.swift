import SwiftUI

/// Chat detail: empty / streaming / error / offline / limit states, matching
/// the edge-case vocabulary in the reference string catalog.
struct ChatView: View {
    @ObservedObject var model: AppModel
    @State private var draft = ""

    var body: some View {
        VStack(spacing: 0) {
            if !model.isOnline {
                BannerView(text: "You're offline", systemImage: "wifi.slash")
            } else if let banner = model.banner {
                BannerView(text: banner, systemImage: "exclamationmark.triangle")
            }
            if let conv = model.selected, !conv.messages.isEmpty {
                transcript(conv)
            } else {
                emptyState
            }
            ComposerView(draft: $draft, isStreaming: model.isStreaming) {
                let text = draft
                draft = ""
                model.send(text)
            } onStop: { model.stop() }
        }
        .background(Tokens.surface)
        .navigationTitle(model.selected?.title ?? "Chat")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Button {} label: {
                    HStack(spacing: Tokens.s1) {
                        Text("Local model").font(Tokens.captionSans.weight(.medium))
                        AppIcon.chevronDown.image(size: 11)
                    }
                    .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: Tokens.s5) {
            Spacer()
            AppIcon.sparkle.image(size: 30).foregroundStyle(Tokens.accent)
            Text("How can I help?")
                .font(Tokens.titleSerif).multilineTextAlignment(.center)
            HStack(spacing: Tokens.s2) {
                ForEach(["Explain a topic", "Help me write", "Review my code"], id: \.self) { chip in
                    Button(chip) { model.send(chip) }
                        .font(Tokens.captionSans)
                        .padding(.horizontal, Tokens.s3).padding(.vertical, Tokens.s2)
                        .background(Tokens.surfaceRaised, in: Capsule())
                        .overlay(Capsule().stroke(Tokens.hairline, lineWidth: 1))
                        .buttonStyle(HapticButtonStyle())
                }
            }
            Spacer()
        }
        .padding(Tokens.s6)
    }

    private func transcript(_ conv: Conversation) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Tokens.s5) {
                    ForEach(conv.messages) { message in
                        MessageRow(message: message).id(message.id)
                    }
                }
                .padding(.horizontal, Tokens.s4).padding(.vertical, Tokens.s4)
            }
            .onChange(of: conv.messages.last?.text) { _, _ in
                if let last = conv.messages.last {
                    withAnimation(Tokens.easeOutFast) { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
        }
    }
}

private struct MessageRow: View {
    let message: ChatMessage

    var body: some View {
        if message.role == .user {
            HStack {
                Spacer(minLength: Tokens.s8)
                Text(message.text)
                    .font(Tokens.bodySans)
                    .padding(.horizontal, Tokens.s4).padding(.vertical, Tokens.s3)
                    .background(Tokens.surfaceRaised, in: RoundedRectangle(cornerRadius: Tokens.radiusL))
            }
        } else {
            VStack(alignment: .leading, spacing: Tokens.s2) {
                Text(message.isStreaming && message.text.isEmpty ? "Thinking…" : message.text)
                    .font(Tokens.bodySerif)
                    .textSelection(.enabled)
                if message.isStreaming {
                    ProgressView().controlSize(.small)
                } else if !message.text.isEmpty {
                    HStack(spacing: Tokens.s4) {
                        Button { UIPasteboard.general.string = message.text } label: {
                            AppIcon.copy.image(size: 14)
                        }
                        .buttonStyle(HapticButtonStyle())
                        .accessibilityLabel("Copy")
                    }
                    .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contextMenu {
                Button { UIPasteboard.general.string = message.text } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                }
            }
        }
    }
}

private struct BannerView: View {
    let text: String
    let systemImage: String
    var body: some View {
        HStack(spacing: Tokens.s2) {
            Image(systemName: systemImage)
            Text(text).font(Tokens.captionSans).lineLimit(3)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Tokens.s4).padding(.vertical, Tokens.s2)
        .background(Color.orange.opacity(0.14))
    }
}
