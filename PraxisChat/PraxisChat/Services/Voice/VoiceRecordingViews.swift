import SwiftUI

/// The voice UI (VOICE_PLAN.md §3): the composer's recording middle, the
/// review row, the recovery banner + list, and the cross-chat pill.
///
/// The mic button's LOOK belongs to tray — these views only render the
/// middle area and the floating banner/pill, in monochrome liquid glass.
struct VoiceRecordingMiddle: View {
    var voice: VoiceInputController
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if voice.permissionDenied {
                deniedView
            } else if let error = voice.startError {
                startErrorView(error)
            } else {
                switch voice.phase {
                case .idle:
                    EmptyView()
                case .recording, .paused:
                    recordingView
                case .transcribing:
                    transcribingView
                case .review:
                    reviewView
                }
            }
        }
        .frame(maxWidth: .infinity, minHeight: 38)
        .padding(.leading, 6)
        .alert("Discard this recording?", isPresented: Bindable(voice).cancelConfirmation) {
            Button("Discard", role: .destructive) { voice.discardConfirmed() }
            Button("Keep recording", role: .cancel) {}
        } message: {
            Text("This recording is over 10 seconds long.")
        }
    }

    // MARK: Recording

    private var recordingView: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                recordDot
                Text(VoiceTime.elapsed(voice.elapsed))
                    .font(Type.mono(13, .footnote))
                    .foregroundStyle(Praxis.mutedInk)
                    .monospacedDigit()
                    .accessibilityLabel("Elapsed \(VoiceTime.elapsed(voice.elapsed))")
                VoiceLevelMeter(level: voice.level)
                    .frame(maxWidth: .infinity)
                pauseResumeButton
                cancelButton
            }
            .frame(minHeight: 38)
            // Stacked full-width: side by side they squeeze to
            // unreadable wrapped pills in the narrow middle.
            VStack(spacing: 6) {
                Button { voice.stopAndTranscribe() } label: {
                    Text("Stop & transcribe")
                        .font(Type.inter(14, weight: .semibold, .subheadline))
                        .foregroundStyle(Praxis.canvas)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 9)
                        .contentShape(Capsule())
                }
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.capsule)
                .tint(Praxis.ink)
                .accessibilityLabel("Stop and transcribe")
                Button { voice.stopAndReview() } label: {
                    Text("Stop & review")
                        .font(Type.inter(14, weight: .medium, .subheadline))
                        .foregroundStyle(Praxis.ink)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 9)
                        .contentShape(Capsule())
                }
                .buttonStyle(PressScaleStyle())
                .praxisGlass(in: Capsule())
                .accessibilityLabel("Stop and review")
            }
            if let notice = voice.pauseNotice, voice.isPausedPhase {
                Button { voice.resumeTapped() } label: {
                    Text(notice)
                        .font(Type.inter(13, .caption))
                        .foregroundStyle(Praxis.secondaryInk)
                }
                .buttonStyle(PressScaleStyle())
                .accessibilityLabel(notice)
            }
            if let warning = voice.lengthWarning {
                Text(warning)
                    .font(Type.inter(13, weight: .medium, .caption))
                    .foregroundStyle(Praxis.destructive)
            }
        }
        .padding(.vertical, 2)
    }

    /// Red dot: pulses only while this view exists (the recording phase),
    /// so no off-screen `repeatForever` outlives it.
    private var recordDot: some View {
        Circle()
            .fill(Color.red)
            .frame(width: 9, height: 9)
            .modifier(RecordPulse(active: voice.phase == .recording && !reduceMotion))
            .accessibilityHidden(true)
    }

    private var pauseResumeButton: some View {
        Button {
            if voice.isPausedPhase { voice.resumeTapped() } else { voice.pauseTapped() }
        } label: {
            Image(systemName: voice.isPausedPhase ? "play.fill" : "pause.fill")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Praxis.ink)
                .frame(width: 32, height: 32)
                .contentShape(Circle())
        }
        .buttonStyle(PressScaleStyle())
        .praxisGlass(in: Circle())
        .accessibilityLabel(voice.isPausedPhase ? "Resume recording" : "Pause recording")
    }

    private var cancelButton: some View {
        Button { voice.cancelTapped() } label: {
            Image(systemName: "xmark")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Praxis.secondaryInk)
                .frame(width: 32, height: 32)
                .contentShape(Circle())
        }
        .buttonStyle(PressScaleStyle())
        .accessibilityLabel("Cancel recording")
    }

    // MARK: Transcribing

    private var transcribingView: some View {
        HStack(spacing: 10) {
            ProgressView(value: voice.transcriptionProgress?.fraction ?? 0)
                .tint(Praxis.ink)
                .frame(maxWidth: .infinity)
            if let notice = voice.transcriptionNotice {
                Text(notice)
                    .font(Type.inter(13, .caption))
                    .foregroundStyle(Praxis.mutedInk)
            } else if let progress = voice.transcriptionProgress, progress.parts > 1 {
                Text("Transcribing \(progress.part)/\(progress.parts)")
                    .font(Type.inter(13, .caption))
                    .foregroundStyle(Praxis.mutedInk)
                    .monospacedDigit()
            } else {
                Text("Transcribing…")
                    .font(Type.inter(13, .caption))
                    .foregroundStyle(Praxis.mutedInk)
            }
            Button { voice.cancelTranscription() } label: {
                Text("Cancel")
                    .font(Type.inter(14, weight: .medium, .subheadline))
                    .foregroundStyle(Praxis.ink)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .contentShape(Capsule())
            }
            .buttonStyle(PressScaleStyle())
            .praxisGlass(in: Capsule())
            .accessibilityLabel("Cancel transcription")
        }
        .frame(minHeight: 38)
        .accessibilityLabel(transcribingLabel)
    }

    private var transcribingLabel: String {
        if let notice = voice.transcriptionNotice {
            return notice
        }
        if let progress = voice.transcriptionProgress, progress.parts > 1 {
            return "Transcribing part \(progress.part) of \(progress.parts)"
        }
        return "Transcribing"
    }

    // MARK: Review

    private var reviewView: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Button { if let id = voice.activeRecording?.id { voice.togglePlay(id: id) } } label: {
                    Image(systemName: voice.playingID == voice.activeRecording?.id ? "pause.fill" : "play.fill")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Praxis.canvas)
                        .frame(width: 32, height: 32)
                        .contentShape(Circle())
                }
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.circle)
                .tint(Praxis.ink)
                .accessibilityLabel(voice.playingID == voice.activeRecording?.id ? "Pause recording" : "Play recording")
                Text(VoiceTime.elapsed(voice.activeRecording?.duration ?? 0))
                    .font(Type.mono(13, .footnote))
                    .foregroundStyle(Praxis.mutedInk)
                    .monospacedDigit()
                Spacer()
            }
            .frame(minHeight: 38)
            HStack(spacing: 8) {
                Button {
                    if let id = voice.activeRecording?.id { voice.transcribeTapped(id: id) }
                } label: {
                    Text(voice.errorMessage == nil ? "Transcribe" : "Retry")
                        .font(Type.inter(14, weight: .semibold, .subheadline))
                        .foregroundStyle(Praxis.canvas)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 9)
                        .contentShape(Capsule())
                }
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.capsule)
                .tint(Praxis.ink)
                .disabled(voice.transcribingID != nil)
                .accessibilityLabel("Transcribe recording")
                Button {
                    if let id = voice.activeRecording?.id { voice.deleteRecording(id: id) }
                } label: {
                    Text("Delete")
                        .font(Type.inter(14, weight: .medium, .subheadline))
                        .foregroundStyle(Praxis.destructive)
                        .lineLimit(1)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 9)
                        .contentShape(Capsule())
                }
                .buttonStyle(PressScaleStyle())
                .praxisGlass(in: Capsule())
                .accessibilityLabel("Delete recording")
            }
            if let error = voice.errorMessage {
                Text(error)
                    .font(Type.inter(13, .caption))
                    .foregroundStyle(Praxis.destructive)
            }
            if let hint = voice.transcribeHint {
                Text(hint)
                    .font(Type.inter(13, .caption))
                    .foregroundStyle(Praxis.secondaryInk)
            }
        }
        .padding(.vertical, 2)
    }

    // MARK: Denied / failed to start

    private var deniedView: some View {
        HStack(spacing: 10) {
            Image(systemName: "mic.slash")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Praxis.secondaryInk)
            VStack(alignment: .leading, spacing: 2) {
                Text("Microphone access is off")
                    .font(Type.inter(14, weight: .medium, .subheadline))
                    .foregroundStyle(Praxis.ink)
                Text("Allow it in Settings to record voice messages.")
                    .font(Type.inter(13, .caption))
                    .foregroundStyle(Praxis.mutedInk)
            }
            Spacer()
            Button {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            } label: {
                Text("Open Settings")
                    .font(Type.inter(14, weight: .semibold, .subheadline))
                    .foregroundStyle(Praxis.canvas)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .contentShape(Capsule())
            }
            .buttonStyle(.glassProminent)
            .buttonBorderShape(.capsule)
            .tint(Praxis.ink)
            .accessibilityLabel("Open Settings")
            Button { voice.dismissNotice() } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Praxis.secondaryInk)
                    .frame(width: 32, height: 32)
                    .contentShape(Circle())
            }
            .buttonStyle(PressScaleStyle())
            .accessibilityLabel("Dismiss microphone prompt")
        }
        .frame(minHeight: 38)
    }

    private func startErrorView(_ error: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Praxis.destructive)
            Text(error)
                .font(Type.inter(14, .subheadline))
                .foregroundStyle(Praxis.ink)
            Spacer()
            Button { voice.dismissNotice() } label: {
                Text("OK")
                    .font(Type.inter(14, weight: .semibold, .subheadline))
                    .foregroundStyle(Praxis.ink)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .contentShape(Capsule())
            }
            .buttonStyle(PressScaleStyle())
            .praxisGlass(in: Capsule())
            .accessibilityLabel("Dismiss recording error")
        }
        .frame(minHeight: 38)
    }
}

/// Live level meter: 24 bars in one pass, driven by the controller's
/// ~10/s poll (no own timers, no animation budget while idle).
struct VoiceLevelMeter: View {
    var level: Float

    var body: some View {
        Canvas { ctx, size in
            let count = 24
            let gap: CGFloat = 3
            let bar = (size.width - CGFloat(count - 1) * gap) / CGFloat(count)
            let lit = Int((CGFloat(level) * CGFloat(count)).rounded())
            for i in 0..<count {
                let on = i < lit
                // Louder bars grow: speech swells toward the right, silence
                // leaves a flat dotted line.
                let h = on ? size.height * (0.35 + 0.65 * CGFloat(i + 1) / CGFloat(count)) : 3
                let rect = CGRect(x: CGFloat(i) * (bar + gap), y: (size.height - h) / 2,
                                  width: max(1, bar), height: h)
                ctx.fill(Path(roundedRect: rect, cornerRadius: 1.5),
                         with: .color(on ? Praxis.ink : Praxis.hairline))
            }
        }
        .frame(height: 26)
        .accessibilityLabel("Recording level")
    }
}

/// Opacity pulse scoped to the recording phase only.
private struct RecordPulse: ViewModifier {
    var active: Bool
    @State private var bright = true

    func body(content: Content) -> some View {
        content
            .opacity(active ? (bright ? 1 : 0.35) : 0.45)
            .onChange(of: active, initial: true) { _, on in
                bright = true
                guard on else { return }
                withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
                    bright = false
                }
            }
    }
}

// MARK: - Recovery banner + list

/// A small banner above the composer while recoverable recordings exist.
/// Tapping it expands the per-recording list (Transcribe / Play / Delete)
/// in place — the same list voice-groq's Settings screen shows.
struct VoiceRecoveryBanner: View {
    var voice: VoiceInputController
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let recordings = voice.recoverable
        if !recordings.isEmpty {
            VStack(spacing: 0) {
                Button { withAnimation(reduceMotion ? Motion.reduced : Motion.morph) { expanded.toggle() } } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "mic.circle")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(Praxis.secondaryInk)
                        Text(summary(recordings))
                            .font(Type.inter(13, weight: .medium, .caption))
                            .foregroundStyle(Praxis.ink)
                            .lineLimit(1)
                        Image(systemName: expanded ? "chevron.down" : "chevron.up")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Praxis.mutedInk)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .contentShape(Capsule())
                }
                .buttonStyle(PressScaleStyle())
                .accessibilityLabel(summary(recordings))
                .accessibilityHint(expanded ? "Hides the recordings" : "Shows the recordings")
                if expanded {
                    VStack(spacing: 0) {
                        if let hint = voice.transcribeHint {
                            Text(hint)
                                .font(Type.inter(13, .caption))
                                .foregroundStyle(Praxis.secondaryInk)
                                .padding(.horizontal, 14)
                                .padding(.bottom, 4)
                        }
                        ForEach(recordings) { recording in
                            VoiceRecoveryRow(voice: voice, recording: recording)
                            if recording.id != recordings.last?.id {
                                Divider().padding(.horizontal, 14)
                            }
                        }
                    }
                    .padding(.bottom, 8)
                }
            }
            .praxisGlass(in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
    }

    private func summary(_ recordings: [VoiceRecording]) -> String {
        if recordings.count == 1, let first = recordings.first {
            return "Recording from \(VoiceTime.short(first.createdAt)) — Review"
        }
        return "\(recordings.count) recordings need review — Review"
    }
}

private struct VoiceRecoveryRow: View {
    var voice: VoiceInputController
    var recording: VoiceRecording

    private var tag: String { VoiceTime.short(recording.createdAt) }
    private var isTranscribing: Bool { voice.transcribingID == recording.id }
    private var isPlaying: Bool { voice.playingID == recording.id }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("\(tag) · \(VoiceTime.elapsed(recording.duration))")
                        .font(Type.inter(14, weight: .medium, .subheadline))
                        .foregroundStyle(Praxis.ink)
                    Text(statusLine)
                        .font(Type.inter(12, .caption2))
                        .foregroundStyle(Praxis.mutedInk)
                }
                Spacer()
                if isTranscribing {
                    // The controller runs one transcription at a time, so a
                    // notice (if any) belongs to this row's recording.
                    if let notice = voice.transcriptionNotice {
                        Text(notice)
                            .font(Type.inter(12, .caption2))
                            .foregroundStyle(Praxis.mutedInk)
                    }
                    if let progress = voice.transcriptionProgress, progress.parts > 1 {
                        Text("\(progress.part)/\(progress.parts)")
                            .font(Type.mono(12, .caption2))
                            .foregroundStyle(Praxis.mutedInk)
                    }
                    ProgressView(value: voice.transcriptionProgress?.fraction ?? 0)
                        .tint(Praxis.ink)
                        .frame(width: 60)
                    Button { voice.cancelTranscription() } label: {
                        Text("Cancel")
                            .font(Type.inter(13, weight: .medium, .caption))
                            .foregroundStyle(Praxis.ink)
                    }
                    .buttonStyle(PressScaleStyle())
                    .accessibilityLabel("Cancel transcription")
                } else {
                    Button { voice.togglePlay(id: recording.id) } label: {
                        Image(systemName: isPlaying ? "pause.fill" : "play.fill")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Praxis.ink)
                            .frame(width: 30, height: 30)
                            .contentShape(Circle())
                    }
                    .buttonStyle(PressScaleStyle())
                    .praxisGlass(in: Circle())
                    .accessibilityLabel("\(isPlaying ? "Pause" : "Play") recording from \(tag)")
                    Button { voice.transcribeTapped(id: recording.id) } label: {
                        Text(recording.state == .failed ? "Retry" : "Transcribe")
                            .font(Type.inter(13, weight: .semibold, .caption))
                            .foregroundStyle(Praxis.canvas)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.glassProminent)
                    .buttonBorderShape(.capsule)
                    .tint(Praxis.ink)
                    .disabled(voice.transcribingID != nil)
                    .accessibilityLabel("Transcribe recording from \(tag)")
                    Button { voice.deleteRecording(id: recording.id) } label: {
                        Image(systemName: "trash")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Praxis.destructive)
                            .frame(width: 30, height: 30)
                            .contentShape(Circle())
                    }
                    .buttonStyle(PressScaleStyle())
                    .accessibilityLabel("Delete recording from \(tag)")
                }
            }
            if voice.errorRecordingID == recording.id, let error = voice.errorMessage {
                Text(error)
                    .font(Type.inter(13, .caption))
                    .foregroundStyle(Praxis.destructive)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
    }

    private var statusLine: String {
        switch recording.state {
        case .recording:
            return "Recording"
        case .paused:
            return recording.duration > 0 ? "Interrupted — audio kept" : "Paused"
        case .stopped:
            return "Recorded — audio kept"
        case .queued:
            return "Queued"
        case .transcribing:
            return "Transcribing…"
        case .transcribed:
            return "Transcribed"
        case .failed:
            return "Couldn't transcribe — audio kept"
        }
    }
}

// MARK: - Cross-chat pill

/// A live recording belongs to the chat it started in; leaving that chat
/// doesn't stop it. This pill floats above the composer anywhere else.
struct VoiceRecordingPill: View {
    var voice: VoiceInputController
    var recording: VoiceRecording
    var onReturn: () -> Void

    var body: some View {
        Button(action: onReturn) {
            HStack(spacing: 8) {
                Circle()
                    .fill(Color.red)
                    .frame(width: 8, height: 8)
                    .accessibilityHidden(true)
                Text(VoiceTime.elapsed(voice.elapsed))
                    .font(Type.mono(13, weight: .medium, .footnote))
                    .foregroundStyle(Praxis.ink)
                    .monospacedDigit()
                Text("Tap to return")
                    .font(Type.inter(13, .caption))
                    .foregroundStyle(Praxis.mutedInk)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .contentShape(Capsule())
        }
        .buttonStyle(PressScaleStyle())
        .praxisGlass(in: Capsule())
        .accessibilityLabel("Return to recording, \(VoiceTime.elapsed(voice.elapsed)) elapsed")
    }
}

// MARK: - Formatting

enum VoiceTime {
    /// 0:07, 12:34, 1:02:03.
    static func elapsed(_ t: TimeInterval) -> String {
        let s = max(0, Int(t))
        let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
        if h > 0 {
            return String(format: "%d:%02d:%02d", h, m, sec)
        }
        return String(format: "%d:%02d", m, sec)
    }

    /// 10:42 (device locale, short time).
    static func short(_ date: Date) -> String {
        ShortTime.shared.string(from: date)
    }

    private final class ShortTime: Sendable {
        static let shared = ShortTime()
        private let formatter: DateFormatter = {
            let formatter = DateFormatter()
            formatter.timeStyle = .short
            formatter.dateStyle = .none
            return formatter
        }()
        private let lock = NSLock()

        func string(from date: Date) -> String {
            lock.lock()
            defer { lock.unlock() }
            return formatter.string(from: date)
        }
    }
}
