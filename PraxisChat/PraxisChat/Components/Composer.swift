import SwiftUI

/// The composer (spec §6). One glass capsule morphing through idle /
/// typing / attachments / recording / streaming — never a swap.
/// Buttons stay pinned to the bottom line; radius stays concentric.
struct ComposerView: View {
    @Environment(ChatStore.self) private var store
    @Binding var trayOpen: Bool
    var namespace: Namespace.ID
    var onSend: () -> Void
    var onAttachmentTap: (Attachment) -> Void = { _ in }
    var onCamera: () -> Void = {}
    /// False when the composer row lives inside the morphed tray
    /// card, which supplies the shared glass instead.
    var showsGlass: Bool = true

    @FocusState private var focused: Bool
    @State private var isRecording = false
    @State private var recordingStart = Date()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var hasText: Bool { !store.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var canSend: Bool { hasText || !store.attachments.isEmpty }
    private var isStreaming: Bool { store.isRunning }

    var body: some View {
        @Bindable var store = store
        Group {
            if showsGlass {
                composerRow
                    .praxisGlass(in: RoundedRectangle(cornerRadius: Praxis.composerRadius, style: .continuous))
                    .glassEffectID("composer", in: namespace)
            } else {
                composerRow
            }
        }
        .animation(reduceMotion ? .easeOut(duration: 0.15) : Motion.morph, value: canSend)
        .animation(reduceMotion ? .easeOut(duration: 0.15) : Motion.reflow, value: store.attachments.count)
        .animation(reduceMotion ? .easeOut(duration: 0.15) : Motion.morph, value: isRecording)
    }

    private var composerRow: some View {
        VStack(spacing: 0) {
            if !store.attachments.isEmpty { attachmentStrip }
            HStack(alignment: .bottom, spacing: 8) {
                plusButton
                middle
                trailingButton
            }
            .padding(9)
        }
    }

    // MARK: Leading +

    private var plusButton: some View {
        Button {
            store.haptics.fire(.light)
            withAnimation(reduceMotion ? .easeOut(duration: 0.15) : Motion.morph) { trayOpen.toggle() }
            focused = false
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(Praxis.ink)
                .rotationEffect(.degrees(trayOpen ? 45 : 0))
                .frame(width: 38, height: 38)
                .contentShape(Circle())
        }
        .buttonStyle(PressScaleStyle())
        .praxisGlass(in: Circle())
        .glassEffectID("plusButton", in: namespace)
        .accessibilityLabel(trayOpen ? "Close add menu" : "Add photos, files and more")
    }

    // MARK: Middle — field or recording waveform

    @ViewBuilder
    private var middle: some View {
        if isRecording {
            HStack(spacing: 10) {
                Waveform()
                    .frame(maxWidth: .infinity)
                TimelineView(.periodic(from: .now, by: 0.5)) { tl in
                    Text(DurationFormatter.live(tl.date.timeIntervalSince(recordingStart)))
                        .font(Type.mono(13, .footnote))
                        .foregroundStyle(Praxis.mutedInk)
                        .monospacedDigit()
                }
            }
            .frame(maxWidth: .infinity, minHeight: 38)
            .padding(.leading, 6)
        } else {
            @Bindable var store = store
            TextField(store.mode.placeholder, text: $store.draft, axis: .vertical)
                .font(Type.inter(17))
                .foregroundStyle(Praxis.ink)
                .lineLimit(1...6)
                .focused($focused)
                .submitLabel(.send)
                .frame(minHeight: 38)
                .padding(.leading, 6)
                .animation(reduceMotion ? .easeOut(duration: 0.15) : Motion.reflow, value: store.draft)
                .accessibilityLabel("Message")
                .accessibilityHint(store.mode.placeholder)
        }
    }

    // MARK: Trailing — camera + mic ↔ send ↔ stop morph

    private var cameraButton: some View {
        Button { onCamera() } label: {
            Image(systemName: "camera")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Praxis.ink)
                .frame(width: 38, height: 38)
                .contentShape(Circle())
        }
        .buttonStyle(PressScaleStyle())
        .praxisGlass(in: Circle())
        .glassEffectID("cameraButton", in: namespace)
        .accessibilityLabel("Take photo")
    }

    private var trailingButton: some View {
        HStack(spacing: 8) {
            // Camera sits left of the mic while idle; once typing
            // starts it fades out to the right as send takes over.
            if !isStreaming && !canSend && !isRecording {
                cameraButton
                    .transition(reduceMotion ? .opacity : .asymmetric(
                        insertion: .opacity.combined(with: .offset(x: 8)),
                        removal: .opacity.combined(with: .offset(x: 12))))
            }
            trailingMorph
        }
    }

    private var trailingMorph: some View {
        Group {
            if isStreaming {
                Button { store.stop() } label: {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(Praxis.canvas)
                }
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.circle)
                .frame(width: 38, height: 38)
                .tint(Praxis.ink)
                .accessibilityLabel("Stop generating")
            } else if canSend {
                Button { onSend() } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(Praxis.canvas)
                }
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.circle)
                .frame(width: 38, height: 38)
                .tint(Praxis.ink)
                .accessibilityLabel("Send message")
            } else if isRecording {
                Button { stopRecording() } label: {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(.white)
                }
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.circle)
                .frame(width: 38, height: 38)
                .tint(Praxis.destructive)
                .accessibilityLabel("Stop recording")
            } else {
                Button { startRecording() } label: {
                    Image(systemName: "mic")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Praxis.ink)
                        .frame(width: 38, height: 38)
                        .contentShape(Circle())
                }
                .buttonStyle(PressScaleStyle())
                .praxisGlass(in: Circle())
                .accessibilityLabel("Record voice message")
            }
        }
        .glassEffectID("trailingButton", in: namespace)
        .contentTransition(.symbolEffect(.replace))
    }

    // MARK: Attachments strip (§6)

    private var attachmentStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(store.attachments) { att in
                    ZStack(alignment: .topTrailing) {
                        AttachmentThumbnail(attachment: att, size: 56)
                            .onTapGesture { onAttachmentTap(att) }
                            .matchedTransitionSource(id: att.id, in: namespace)
                        Button {
                            withAnimation(Motion.reflow) {
                                store.attachments.removeAll { $0.id == att.id }
                            }
                        } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 8, weight: .bold))
                                .foregroundStyle(Praxis.ink)
                                .frame(width: 20, height: 20)
                                .contentShape(Circle())
                        }
                        .buttonStyle(PressScaleStyle())
                        .praxisGlass(in: Circle())
                        .offset(x: 4, y: -4)
                        .accessibilityLabel("Remove \(att.name)")
                    }
                    .padding(.top, 6)
                    .padding(.trailing, 4)
                }
            }
            .padding(.horizontal, 12)
        }
        .padding(.top, 6)
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    }

    // MARK: Recording (simulated amplitudes, §6)

    private func startRecording() {
        store.haptics.fire(.light)
        recordingStart = Date()
        withAnimation(Motion.morph) { isRecording = true }
    }

    private func stopRecording() {
        withAnimation(Motion.morph) { isRecording = false }
        // Mock transcription types into the field (§6).
        let transcript = "Draft a follow-up on the glass contrast audit"
        store.draft = transcript
        focused = true
    }
}

/// Live waveform with simulated amplitudes (§6). Bars fill
/// whatever width the composer middle offers.
private struct Waveform: View {
    var body: some View {
        GeometryReader { geo in
            TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { tl in
                let t = tl.date.timeIntervalSinceReferenceDate
                let count = max(8, Int(geo.size.width / 7))
                HStack(spacing: 3) {
                    ForEach(0..<count, id: \.self) { i in
                        RoundedRectangle(cornerRadius: 2, style: .continuous)
                            .fill(Praxis.ink)
                            .frame(width: 3, height: 6 + 14 * abs(sin(t * 3 + Double(i) * 0.7)))
                    }
                }
                .frame(width: geo.size.width, height: geo.size.height, alignment: .leading)
            }
        }
        .frame(height: 26)
        .accessibilityLabel("Recording")
    }
}
