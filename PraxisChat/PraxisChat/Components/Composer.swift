import SwiftUI

struct ComposerView: View {
    @Environment(ChatStore.self) private var store
    var trayOpen: Bool
    var namespace: Namespace.ID
    /// Routed through owner so haptics, spring, and page reset stay consistent.
    var onToggleTray: () -> Void = {}
    var onSend: () -> Void
    var onAttachmentTap: (Attachment) -> Void = { _ in }
    var onCamera: () -> Void = {}
    /// False inside expanded tray card so parent glass wraps both.
    var showsGlass: Bool = true
    var isModelSearch: Bool = false
    var onModelSearchSubmit: () -> Void = {}

    @FocusState private var focused: Bool
    @State private var lastSend: (text: String, at: Date)?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.sendLaunch) private var sendLaunch

    private var hasText: Bool { !store.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var canSend: Bool { hasText || !store.attachments.isEmpty }
    private var isStreaming: Bool { store.isRunning }
    private var voice: VoiceInputController? { store.voice }
    private var voiceShowsUI: Bool { voice?.showsRecordingUI == true }

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
        .animation(reduceMotion ? Motion.reduced : Motion.morph, value: canSend)
        .animation(reduceMotion ? Motion.reduced : Motion.morph, value: isStreaming)
        .animation(reduceMotion ? Motion.reduced : Motion.reflow, value: store.attachments.count)
        .animation(reduceMotion ? Motion.reduced : Motion.morph, value: voiceShowsUI)
    }

    private var composerRow: some View {
        VStack(spacing: 0) {
            if !store.attachments.isEmpty { attachmentStrip }
            if let hint = store.imageInputHint { ImageInputHintRow(hint: hint) }
            if let hint = store.toolSupportHint { ToolSupportHintRow(hint: hint) }
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
            focused = false
            onToggleTray()
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(Praxis.canvas)
                .rotationEffect(.degrees(trayOpen ? 45 : 0))
                .animation(reduceMotion ? Motion.reduced : Motion.pop, value: trayOpen)
                .frame(width: 38, height: 38)
                .contentShape(Circle())
        }
        .buttonStyle(PressScaleStyle())
        .background(Praxis.ink, in: Circle())
        .accessibilityLabel(trayOpen ? "Close add menu" : "Add photos, files and more")
    }

    // MARK: Middle — field or recording waveform

    @ViewBuilder
    private var middle: some View {
        if let voice, voice.showsRecordingUI {
            VoiceRecordingMiddle(voice: voice)
        } else if isModelSearch {
            searchField
        } else {
            @Bindable var store = store
            TextField(store.mode.placeholder, text: $store.draft, axis: .vertical)
                .font(Type.inter(17))
                .foregroundStyle(Praxis.ink)
                .lineLimit(1...6)
                .focused($focused)
                .submitLabel(.send)
                .frame(minHeight: 38)
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { sendLaunch?.track($0) }
                .padding(.leading, 6)
                // Animate the field only when a line wraps, not per keystroke.
                .animation(reduceMotion ? Motion.reduced : Motion.reflow, value: lineEstimate)
                .accessibilityLabel("Message")
                .accessibilityHint(store.mode.placeholder)
                .onChange(of: store.draft) { _, text in rejectRecommit(text) }
        }
    }

    // MARK: Model search (tray Model page open)

    /// Separate view from draft so search text never shares TextField state.
    private var searchField: some View {
        TextField("Search models", text: Binding(get: { store.modelQuery }, set: { store.modelQuery = $0 }))
            .font(Type.inter(17))
            .foregroundStyle(Praxis.ink)
            .submitLabel(.search)
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .frame(minHeight: 38)
            .padding(.leading, 6)
            .accessibilityLabel("Search models")
            .onSubmit { onModelSearchSubmit() }
    }

    // MARK: Sending

    /// Clears UITextView directly on send to avoid keyboard autocommit race.
    private func send() {
        let text = store.draft
        onSend()
        guard store.draft.isEmpty, !text.isEmpty else { return }
        lastSend = (text, Date())
        ComposerInput.clearFocusedTextView()
        #if DEBUG
        ComposerInput.simulateKeyboardEditIfTesting()
        #endif
    }

    /// Rejects late keyboard recommit of just-sent text inside race window.
    private func rejectRecommit(_ text: String) {
        guard let sent = lastSend, !text.isEmpty else { return }
        guard Date().timeIntervalSince(sent.at) < 1 else { lastSend = nil; return }
        let shared = zip(text, sent.text).prefix { $0 == $1 }.count
        guard text.count >= 2, shared * 2 >= sent.text.count else { return }
        lastSend = nil
        store.draft = ""
        ComposerInput.clearFocusedTextView()
    }

    // MARK: Trailing — camera + mic ↔ send ↔ stop morph

    private var cameraButton: some View {
        Button { onCamera() } label: {
            Image(systemName: "camera")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Praxis.canvas)
                .frame(width: 38, height: 38)
                .contentShape(Circle())
        }
        .buttonStyle(PressScaleStyle())
        .background(Praxis.ink, in: Circle())
        .accessibilityLabel("Take photo")
    }

    private var trailingButton: some View {
        HStack(spacing: 8) {
            if !isStreaming && !canSend && !voiceShowsUI && !isModelSearch {
                cameraButton
                    .transition(reduceMotion ? .opacity : .asymmetric(
                        insertion: .opacity.combined(with: .offset(x: 8)),
                        removal: .opacity.combined(with: .offset(x: 12))))
            }
            trailingMorph
        }
    }

    private var lineEstimate: Int {
        store.draft.reduce(into: 1) { if $1 == "\n" { $0 += 1 } } + store.draft.count / 34
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
            } else if isModelSearch {
                if !store.modelQuery.isEmpty {
                    Button { store.modelQuery = "" } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 17))
                            .foregroundStyle(Praxis.mutedInk)
                            .frame(width: 38, height: 38)
                            .contentShape(Circle())
                    }
                    .buttonStyle(PressScaleStyle())
                    .accessibilityLabel("Clear search")
                } else {
                    Color.clear.frame(width: 38, height: 38)
                        .accessibilityHidden(true)
                }
            } else if canSend {
                Button { send() } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(Praxis.canvas)
                }
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.circle)
                .frame(width: 38, height: 38)
                .tint(Praxis.ink)
                .transition(reduceMotion ? .opacity : .scale(scale: 0.5).combined(with: .opacity))
                .accessibilityLabel("Send message")
            } else if voice?.showsStopButton == true {
                Button { voice?.stopAndTranscribe() } label: {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(.white)
                }
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.circle)
                .frame(width: 38, height: 38)
                .tint(Praxis.destructive)
                .accessibilityLabel("Stop recording")
            } else if !voiceShowsUI {
                Button { voice?.micTapped() } label: {
                    Image(systemName: "mic")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Praxis.canvas)
                        .frame(width: 38, height: 38)
                        .contentShape(Circle())
                }
                .buttonStyle(PressScaleStyle())
                .background(Praxis.ink, in: Circle())
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
                            .codeAccessMenu(att) { hidden in
                                withAnimation(Motion.snap) { store.setHiddenFromCode(hidden, attachmentID: att.id) }
                            }
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

    // MARK: Recording — VoiceInputController owns it (see
}

@MainActor
enum ComposerInput {
    fileprivate static weak var reported: UIResponder?

    static func firstResponder() -> UIResponder? {
        reported = nil
        UIApplication.shared.sendAction(#selector(UIResponder.praxisReportFirstResponder), to: nil, from: nil, for: nil)
        return reported
    }

    /// Clears first-responder UITextView and drops marked composition text.
    static func clearFocusedTextView() {
        guard let textView = firstResponder() as? UITextView,
              textView.markedTextRange != nil || !textView.text.isEmpty else { return }
        // Assigning empty text drops composition instead of committing like unmarkText.
        textView.text = ""
    }
}

#if DEBUG
extension ComposerInput {
    /// Replays post-send keyboard candidate commit for UI tests.
    static func simulateKeyboardEditIfTesting() {
        guard UserDefaults.standard.bool(forKey: "PraxisSimulateKeyboardCommit"),
              let textView = firstResponder() as? UITextView else { return }
        textView.delegate?.textViewDidChange?(textView)
    }
}
#endif

extension UIResponder {
    @objc fileprivate func praxisReportFirstResponder() {
        ComposerInput.reported = self
    }
}
