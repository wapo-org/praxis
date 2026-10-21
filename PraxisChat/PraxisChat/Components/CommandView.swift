import SwiftUI

/// Level 3 — command execution view (spec §9). Card radius 8, hairline,
/// fill-1, clipped. Streaming output auto-scrolls, feathered 16pt edges.
struct CommandView: View {
    let command: CommandData
    @State private var startedAt = Date()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Command line
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("$").font(Type.mono(12, weight: .semibold)).foregroundStyle(Praxis.mutedInk)
                Text(command.code)
                    .font(Type.mono(12, .caption))
                    .lineSpacing(6)
                    .foregroundStyle(Praxis.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 12)
            .padding(.top, 10)

            // Meta row
            HStack(spacing: 12) {
                if command.isRunning {
                    TimelineView(.periodic(from: .now, by: 0.1)) { tl in
                        HStack(spacing: 12) {
                            Text("RUNNING")
                                .font(Type.mono(10, weight: .medium, .caption2)).tracking(0.8)
                                .foregroundStyle(Praxis.mutedInk)
                            Text(DurationFormatter.live(tl.date.timeIntervalSince(startedAt)))
                                .font(Type.mono(10, .caption2)).tracking(0.4)
                                .foregroundStyle(Praxis.mutedInk).monospacedDigit()
                        }
                    }
                } else if let exit = command.exitCode {
                    Text("EXIT \(exit)")
                        .font(Type.mono(10, weight: .medium, .caption2)).tracking(0.8)
                        .foregroundStyle(exit == 0 ? Praxis.success : Praxis.destructive)
                    Text(DurationFormatter.live(command.duration))
                        .font(Type.mono(10, .caption2)).tracking(0.4)
                        .foregroundStyle(Praxis.mutedInk).monospacedDigit()
                }
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.top, 6)
            .padding(.bottom, 10)

            if !command.lines.isEmpty {
                Rectangle().fill(Praxis.hairline).frame(height: 1)
                ZStack {
                    ScrollViewReader { proxy in
                        ScrollView {
                            VStack(alignment: .leading, spacing: 2) {
                                ForEach(Array(command.lines.enumerated()), id: \.offset) { i, line in
                                    Text(line)
                                        .font(Type.mono(11, .caption2))
                                        .lineSpacing(6)
                                        .foregroundStyle(Praxis.mutedInk)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .id(i)
                                }
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                        }
                        .onChange(of: command.lines.count) { _, n in
                            withAnimation(Motion.reflow) { proxy.scrollTo(max(n - 1, 0), anchor: .bottom) }
                        }
                    }
                    VStack {
                        ProgressiveBlurScrim(edge: .top, length: 16, maxRadius: 6)
                        Spacer()
                        ProgressiveBlurScrim(edge: .bottom, length: 16, maxRadius: 6)
                    }
                }
                .frame(maxHeight: 160)
            }
        }
        .background(Praxis.fill1, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Praxis.hairline, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .onAppear { startedAt = Date() }
    }
}
