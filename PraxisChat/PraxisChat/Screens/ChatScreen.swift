import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

/// Chat screen (spec §5): glass toolbar, transcript under progressive
/// scrims, composer in `safeAreaBar`, jump-to-latest, plus tray overlay.
struct ChatScreen: View {
    @Environment(ChatStore.self) private var store
    @Namespace private var glassNS
    @State private var trayOpen = false
    @State private var trayPage: TrayPage = .main
    @State private var showHistory = false
    @State private var filePreview: String?
    @State private var linkPreview: URL?
    @State private var showCopied = false
    @State private var isAtBottom = true
    @State private var distanceFromBottom: CGFloat = 0
    @State private var viewerAttachment: Attachment?
    @State private var jumpTrigger = 0
    @State private var showPhotos = false
    @State private var showFiles = false
    @State private var showCamera = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var screenCorners = ScreenCorners()
    @State private var keyboardUp = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var conversation: Conversation? { store.selected }

    // MARK: Composer placement — concentric with the screen corners

    /// The card's 28pt corners share their centre with the display
    /// corner, so the gap is equal along the sides, bottom and curve.
    private var composerInset: CGFloat {
        screenCorners.concentricInset(for: Praxis.composerRadius)
    }

    /// The safe-area bar already lifts the card by the home-indicator
    /// inset; pad or drop the remainder so the visible bottom gap equals
    /// the side inset. Over the keyboard it simply floats 8pt above.
    private var composerBottomPadding: CGFloat {
        keyboardUp ? 8 : max(0, composerInset - screenCorners.bottomInset)
    }

    private var composerDrop: CGFloat {
        keyboardUp ? 0 : max(0, screenCorners.bottomInset - composerInset)
    }

    var body: some View {
        NavigationStack {
            ZStack(alignment: .bottom) {
                Praxis.canvas.ignoresSafeArea()
                    .background(ScreenCornerReader(corners: $screenCorners))
                transcript

                // Progressive scrims (§3): top to ~24pt below toolbar,
                // bottom to ~32pt above the composer. No visible edge.
                VStack {
                    ProgressiveBlurScrim(edge: .top, length: 120, maxRadius: 18)
                    Spacer()
                    ProgressiveBlurScrim(edge: .bottom, length: 130, maxRadius: 18)
                }
                .ignoresSafeArea(edges: [.top, .bottom])
                .allowsHitTesting(false)

                if distanceFromBottom > 700 {
                    jumpButton
                        .padding(.bottom, 84)
                        .transition(reduceMotion ? .opacity : .scale(scale: 0.8).combined(with: .opacity))
                }



                if showCopied {
                    CopiedToast()
                        .padding(.bottom, 96)
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                        .zIndex(3)
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showHistory = true } label: {
                        Image(systemName: "clock.arrow.circlepath")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(Praxis.ink)
                            .frame(width: 44, height: 44)
                            .contentShape(Circle())
                    }
                    .buttonStyle(PressScaleStyle())
                    .praxisGlass(in: Circle())
                    .accessibilityLabel("History")
                }
                // Our glass circle only: the bar's shared glass would
                // wrap it in a second ring.
                .sharedBackgroundVisibility(.hidden)
                ToolbarItem(placement: .principal) {
                    Button {
                        trayPage = .models
                        withAnimation(Motion.morph) { trayOpen = true }
                    } label: {
                        VStack(spacing: 1) {
                            Text(conversation?.title ?? "Praxis Chat")
                                .font(Type.inter(15, weight: .semibold, .body))
                                .foregroundStyle(Praxis.ink)
                                .lineLimit(1)
                            Text(store.model.name)
                                .font(Type.inter(11, .caption2))
                                .foregroundStyle(Praxis.mutedInk)
                                .contentTransition(.opacity)
                        }
                    }
                    .buttonStyle(PressScaleStyle())
                    .accessibilityLabel("Conversation, \(conversation?.title ?? "New chat"), model \(store.model.name)")
                    .accessibilityHint("Opens model picker")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        store.newChat()
                    } label: {
                        Image(systemName: "square.and.pencil")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(Praxis.ink)
                            .frame(width: 44, height: 44)
                            .contentShape(Circle())
                    }
                    .buttonStyle(PressScaleStyle())
                    .praxisGlass(in: Circle())
                    .accessibilityLabel("New chat")
                }
                .sharedBackgroundVisibility(.hidden)
            }
            .toolbarBackgroundVisibility(.hidden, for: .navigationBar)
            .safeAreaBar(edge: .bottom) {
                // A single glass card that morphs: composer when
                // closed, tray content + composer row when open.
                // They never appear as two separate cards.
                GlassEffectContainer(spacing: 8) {
                    Group {
                        if trayOpen {
                            VStack(spacing: 0) {
                                PlusTray(isOpen: $trayOpen, page: $trayPage,
                                         showPhotos: $showPhotos, showFiles: $showFiles,
                                         showCamera: $showCamera, namespace: glassNS)
                                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: 6)))
                                ComposerView(trayOpen: $trayOpen, namespace: glassNS, onSend: {
                                    store.send(text: store.draft)
                                }, onAttachmentTap: { att in
                                    viewerAttachment = att
                                }, onCamera: { showCamera = true }, showsGlass: false)
                            }
                            .praxisGlass(in: RoundedRectangle(cornerRadius: Praxis.composerRadius, style: .continuous), interactive: false)
                            .glassEffectID("composer", in: glassNS)
                        } else {
                            ComposerView(trayOpen: $trayOpen, namespace: glassNS) {
                                store.send(text: store.draft)
                            } onAttachmentTap: { att in
                                viewerAttachment = att
                            } onCamera: {
                                showCamera = true
                            }
                        }
                    }
                    .padding(.horizontal, composerInset)
                    .padding(.bottom, composerBottomPadding)
                    .offset(y: composerDrop)
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
                keyboardUp = true
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
                keyboardUp = false
            }
            .photosPicker(isPresented: $showPhotos, selection: $photoItems, matching: .images)
            .onChange(of: photoItems) { _, items in loadPhotos(items) }
            .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                if case .success(let urls) = result {
                    for url in urls {
                        store.attachments.append(Attachment(kind: .file, name: url.lastPathComponent))
                    }
                    if !urls.isEmpty { closeTray() }
                }
            }
            .fullScreenCover(isPresented: $showCamera) {
                CameraPicker { image in
                    if let data = image.jpegData(compressionQuality: 0.8) {
                        store.attachments.append(Attachment(kind: .camera, name: "Camera photo", imageData: data))
                    }
                    closeTray()
                }
                .ignoresSafeArea()
            }
            .sheet(isPresented: $showHistory) { HistorySheet() }
            .sheet(item: $filePreview) { name in FilePreviewSheet(name: name) }
            .sheet(item: $linkPreview) { url in LinkPreviewSheet(url: url) }
            .navigationDestination(item: $viewerAttachment) { att in
                PhotoViewer(attachment: att)
                    .navigationTransition(.zoom(sourceID: att.id, in: glassNS))
            }
        }
        .animation(reduceMotion ? .easeOut(duration: 0.15) : Motion.morph, value: trayOpen)
        .animation(Motion.morph, value: distanceFromBottom > 700)
    }

    // MARK: Transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                Group {
                    if let conv = conversation, !conv.turns.isEmpty {
                        LazyVStack(alignment: .leading, spacing: Praxis.turnGap) {
                            ForEach(conv.turns) { turn in
                                TurnView(turn: turn, onChipAction: handleChip)
                                    .id(turn.id)
                            }
                            Color.clear.frame(height: 8).id("transcript-bottom")
                        }
                        .padding(.horizontal, Praxis.margin)
                        .padding(.top, 16)
                        .padding(.bottom, 24)
                        .frame(maxWidth: 680)
                        .frame(maxWidth: .infinity)
                    } else {
                        emptyState
                    }
                }
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .scrollEdgeEffectStyle(.soft, for: .top)
            .scrollEdgeEffectStyle(.soft, for: .bottom)
            .onScrollGeometryChange(for: CGFloat.self) { geo in
                geo.contentSize.height - (geo.contentOffset.y + geo.containerSize.height)
            } action: { _, newValue in
                distanceFromBottom = max(newValue, 0)
                isAtBottom = newValue < 260
            }
            .onChange(of: conversation?.turns.last?.blocks.count) { _, _ in follow(proxy) }
            .onChange(of: lastContentFingerprint) { _, _ in follow(proxy) }
            .onChange(of: jumpTrigger) { _, _ in
                isAtBottom = true
                withAnimation(Motion.reflow) { proxy.scrollTo("transcript-bottom", anchor: .bottom) }
            }
        }
    }

    private var lastContentFingerprint: Int {
        guard let turn = conversation?.turns.last else { return 0 }
        return turn.blocks.reduce(0) { acc, block in
            switch block {
            case .activity(let a): return acc + a.steps.reduce(0) { $0 + $1.traces.count + ($1.command?.lines.count ?? 0) }
            case .markdown(_, let src, _): return acc + src.count
            }
        }
    }

    private func follow(_ proxy: ScrollViewProxy) {
        guard isAtBottom else { return }
        // During streaming this fires per chunk; animating every jump
        // makes the transcript chase its own tail. Snap while running,
        // glide otherwise.
        if store.isRunning {
            proxy.scrollTo("transcript-bottom", anchor: .bottom)
        } else {
            withAnimation(Motion.reflow) { proxy.scrollTo("transcript-bottom", anchor: .bottom) }
        }
    }

    private func closeTray() {
        store.haptics.fire(.soft)
        withAnimation(reduceMotion ? .easeOut(duration: 0.15) : Motion.morph) {
            trayOpen = false
            trayPage = .main
        }
    }

    private func loadPhotos(_ items: [PhotosPickerItem]) {
        Task {
            for item in items {
                if let data = try? await item.loadTransferable(type: Data.self) {
                    store.attachments.append(Attachment(kind: .photo, name: "Photo", imageData: data))
                }
            }
            if !items.isEmpty { closeTray() }
        }
    }

    private var jumpButton: some View {
        Button {
            jumpTrigger += 1
        } label: {
            Image(systemName: "arrow.down")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Praxis.ink)
                .frame(width: 36, height: 36)
                .contentShape(Circle())
        }
        .buttonStyle(PressScaleStyle())
        .praxisGlass(in: Circle())
        .accessibilityLabel("Jump to latest")
    }

    private var emptyState: some View {
        VStack(spacing: 22) {
            Spacer(minLength: 90)
            Text("How can I help?")
                .font(Type.serif(30, weight: .semibold, .largeTitle))
                .foregroundStyle(Praxis.ink)
            FlowSuggestions()
            Spacer()
        }
        .padding(.horizontal, Praxis.margin)
        .frame(maxWidth: 680)
        .frame(maxWidth: .infinity)
    }

    private func handleChip(_ action: ChipAction) {
        switch action {
        case .file(let name): filePreview = name
        case .link(let url): linkPreview = url
        case .copied:
            store.haptics.fire(.selection)
            withAnimation(Motion.snap) { showCopied = true }
            Task { try? await Task.sleep(for: .seconds(1.2)); showCopied = false }
        }
    }
}

extension String: @retroactive Identifiable {
    public var id: String { self }
}

extension URL: @retroactive Identifiable {
    public var id: String { absoluteString }
}

/// Suggestion capsules (Thin glass, §5): tapping one sends it.
private struct FlowSuggestions: View {
    @Environment(ChatStore.self) private var store
    var body: some View {
        VStack(spacing: 10) {
            ForEach(MockData.suggestions, id: \.self) { suggestion in
                Button {
                    store.send(text: suggestion)
                } label: {
                    Text(suggestion)
                        .font(Type.inter(14, .subheadline))
                        .foregroundStyle(Praxis.ink)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .contentShape(Capsule())
                }
                .buttonStyle(PressScaleStyle())
                .praxisGlass(in: Capsule())
                .accessibilityLabel(suggestion)
            }
        }
    }
}

/// One turn: user bubble, then blocks (activity 24pt apart from prose,
/// answer 20pt below activity), then the quiet action row (§5/§8/§9).
private struct TurnView: View {
    @Environment(ChatStore.self) private var store
    let turn: Turn
    var onChipAction: (ChipAction) -> Void = { _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: Praxis.bubbleToAnswer) {
            UserBubble(turn: turn,
                       onEdit: { store.edit(turnID: turn.id) },
                       onResend: { store.resend(turnID: turn.id) })

            ForEach(Array(turn.blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .activity(let activity):
                    AgentActivityView(activity: activity, turnID: turn.id) { expanded in
                        withAnimation(Motion.reflow) {
                            store.setActivityExpanded(turnID: turn.id, blockID: activity.id, expanded: expanded)
                        }
                    } onCommandToggle: { stepID, expanded in
                        store.setCommandExpanded(turnID: turn.id, stepID: stepID, expanded: expanded)
                    }
                case .markdown(_, let source, let isStreaming):
                    AgentMessageView(source: source, isStreaming: isStreaming, onChipAction: onChipAction)
                }
            }

            if turn.isFinished && !turn.blocks.isEmpty {
                MessageActionRow(
                    onCopy: {
                        UIPasteboard.general.string = turn.blocks.compactMap {
                            if case .markdown(_, let s, _) = $0 { return s }; return nil
                        }.joined(separator: "\n\n")
                    },
                    onRetry: { store.retry(turnID: turn.id) },
                    feedback: turn.feedback,
                    onFeedback: { store.setFeedback(turnID: turn.id, feedback: $0) },
                    shareText: turn.userText
                )
                .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Full-screen photo viewer (§11 zoom transition destination).
struct PhotoViewer: View {
    let attachment: Attachment
    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let data = attachment.imageData, let img = UIImage(data: data) {
                Image(uiImage: img)
                    .resizable()
                    .scaledToFit()
                    .padding(12)
            } else {
                Image(systemName: "photo")
                    .font(.system(size: 48))
                    .foregroundStyle(.white.opacity(0.6))
            }
        }
        .navigationTitle(attachment.name)
        .navigationBarTitleDisplayMode(.inline)
    }
}
