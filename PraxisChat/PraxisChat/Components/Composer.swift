import SwiftUI

/// The composer (spec §6). One glass capsule morphing through idle /
/// typing / attachments / recording / streaming — never a swap.
/// Buttons stay pinned to the bottom line; radius stays concentric.
struct ComposerView: View {
    @Environment(ChatStore.self) private var store
    var trayOpen: Bool
    var namespace: Namespace.ID
    /// Opening/closing goes through the owner so haptics, spring and page
    /// reset are the same from every trigger.
    var onToggleTray: () -> Void = {}
    var onSend: () -> Void
    var onAttachmentTap: (Attachment) -> Void = { _ in }
    var onCamera: () -> Void = {}
    /// False when the composer row lives inside the morphed tray
    /// card, which supplies the shared glass instead.
    var showsGlass: Bool = true

    @FocusState private var focused: Bool
    /// The text just sent, for a short while: see `send()`.
    @State private var lastSend: (text: String, at: Date)?
    @State private var isRecording = false
    @State private var recordingStart = Date()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.sendLaunch) private var sendLaunch

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
        .animation(reduceMotion ? Motion.reduced : Motion.morph, value: canSend)
        .animation(reduceMotion ? Motion.reduced : Motion.morph, value: isStreaming)
        .animation(reduceMotion ? Motion.reduced : Motion.reflow, value: store.attachments.count)
        .animation(reduceMotion ? Motion.reduced : Motion.morph, value: isRecording)
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
        // Solid ink, not glass: the composer field stays glass, its
        // satellite buttons read as solid black/white (item 10).
        .background(Praxis.ink, in: Circle())
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
                // Where a sent bubble rises from.
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { sendLaunch?.track($0) }
                .padding(.leading, 6)
                // Animate the field only when a line wraps, not per keystroke.
                .animation(reduceMotion ? Motion.reduced : Motion.reflow, value: lineEstimate)
                .accessibilityLabel("Message")
                .accessibilityHint(store.mode.placeholder)
                .onChange(of: store.draft) { _, text in rejectRecommit(text) }
        }
    }

    // MARK: Sending

    /// Sends, then makes sure the field is really empty.
    ///
    /// Clearing `draft` alone loses a race with the keyboard: the binding's
    /// "" only reaches the text view on SwiftUI's next update, and any edit
    /// the keyboard makes before that — committing a candidate or marked
    /// text, an autocorrect replacement, a late keystroke — makes SwiftUI
    /// copy the view's text (still the whole sent message) back into
    /// `draft`. The update then finds the two agreeing and clears nothing.
    /// Emptying the text view in the same turn as the send leaves nothing
    /// stale for such an edit to copy back.
    private func send() {
        let text = store.draft
        onSend()
        // Held for consent (or nothing to send): the draft stays.
        guard store.draft.isEmpty, !text.isEmpty else { return }
        lastSend = (text, Date())
        ComposerInput.clearFocusedTextView()
        #if DEBUG
        ComposerInput.simulateKeyboardEditIfTesting()
        #endif
    }

    /// Backstop for the same race: the keyboard committing the old text
    /// right after a send. A user can't retype most of a message in under
    /// a second, so a draft that reappears that fast is the sent text.
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

    /// Coarse line count driving the growth animation: changes when the
    /// draft wraps or gains a newline, not on every character.
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

    // MARK: Recording (simulated amplitudes, §6)

    private func startRecording() {
        store.haptics.fire(.light)
        recordingStart = Date()
        withAnimation(reduceMotion ? Motion.reduced : Motion.morph) { isRecording = true }
    }

    private func stopRecording() {
        store.haptics.fire(.soft)
        withAnimation(reduceMotion ? Motion.reduced : Motion.morph) { isRecording = false }
        // Mock transcription types into the field (§6).
        let transcript = "Draft a follow-up on the glass contrast audit"
        store.draft = transcript
        focused = true
    }
}

/// Live waveform with simulated amplitudes (§6). Bars fill whatever
/// width the composer middle offers. Drawn in one Canvas pass: no
/// per-bar views, no layout, 30 times a second.
private struct Waveform: View {
    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate
            Canvas { ctx, size in
                let count = max(8, Int(size.width / 7))
                for i in 0..<count {
                    let h = 6 + 14 * abs(sin(t * 3 + Double(i) * 0.7))
                    let rect = CGRect(x: Double(i) * 6, y: (size.height - h) / 2, width: 3, height: h)
                    ctx.fill(RoundedRectangle(cornerRadius: 2, style: .continuous).path(in: rect),
                             with: .color(Praxis.ink))
                }
            }
        }
        .frame(height: 26)
        .accessibilityLabel("Recording")
    }
}

/// The UIKit text view behind the focused composer field (SwiftUI's
/// vertical `TextField` is a `UITextView` subclass while it's focused).
@MainActor
enum ComposerInput {
    fileprivate static weak var reported: UIResponder?

    /// The current first responder, if any.
    static func firstResponder() -> UIResponder? {
        reported = nil
        UIApplication.shared.sendAction(#selector(UIResponder.praxisReportFirstResponder), to: nil, from: nil, for: nil)
        return reported
    }

    /// Empties the first responder's text if it's a text view, dropping
    /// any marked text (composition, inline prediction) with it. The
    /// field's binding is already "" by then, so the two agree at once.
    static func clearFocusedTextView() {
        guard let textView = firstResponder() as? UITextView,
              textView.markedTextRange != nil || !textView.text.isEmpty else { return }
        // Replacing the text ends the composition without committing it
        // (`unmarkText()` would commit it and echo it back through the
        // delegate into the draft).
        textView.text = ""
    }
}

#if DEBUG
extension ComposerInput {
    /// UI tests (`-PraxisSimulateKeyboardCommit YES`): play the edit a
    /// device keyboard makes right after a send — committing its
    /// candidate — inside the race window, before SwiftUI's next update.
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
