import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

/// Owns only presentation state; scroll geometry and streaming stay isolated from chrome.
struct ChatScreen: View {
    @Environment(ChatStore.self) private var store
    @Namespace private var glassNS
    @State private var sendLaunch = SendLaunch()
    @State private var trayOpen = UserDefaults.standard.bool(forKey: "PraxisOpenTray")
    @State private var trayPage: TrayPage = .main
    @State private var showHistory = false
    @State private var filePreview: String?
    @State private var linkPreview: URL?
    @State private var showCopied = false
    @State private var hideCopied: Task<Void, Never>?
    @State private var viewerAttachment: Attachment?
    @State private var showPhotos = false
    @State private var showFiles = false
    @State private var showCamera = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var screenCorners = ScreenCorners()
    @State private var screenHeight: CGFloat = 800
    @State private var keyboardUp = false
    @State private var composerReserve: CGFloat = 72
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    private var conversation: Conversation? { store.selected }

    private var maxTrayHeight: CGFloat { min(540, max(260, screenHeight * 0.6)) }

    var body: some View {
        NavigationStack {
            ZStack(alignment: .bottom) {
                Praxis.canvas.ignoresSafeArea()
                    .background(ScreenCornerReader(corners: $screenCorners))
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { screenHeight = $0 }

                TranscriptView(conversation: conversation, trayOpen: trayOpen,
                               bottomReserve: composerReserve, onChipAction: handleChip)

                // Custom bottom scrim needed because ZStack-floating composer isn't seen by scrollEdgeEffect.
                VStack {
                    Spacer()
                    ProgressiveBlurScrim(edge: .bottom, length: 150, hold: 0.36)
                }
                .ignoresSafeArea(edges: .bottom)
                .allowsHitTesting(false)

                if trayOpen {
                    Color.clear
                        .contentShape(Rectangle())
                        .ignoresSafeArea()
                        .onTapGesture { setTray(false) }
                        .gesture(DragGesture(minimumDistance: 12).onEnded { _ in setTray(false) })
                        .accessibilityHidden(true)
                }

                // Floats in ZStack because safeAreaBar clips hit-testing and accessibility to its own frame.
                ComposerDock(trayOpen: trayOpen, trayPage: $trayPage,
                             showPhotos: $showPhotos, showFiles: $showFiles, showCamera: $showCamera,
                             viewerAttachment: $viewerAttachment, reserve: $composerReserve,
                             namespace: glassNS,
                             screenCorners: screenCorners, keyboardUp: keyboardUp,
                             maxTrayHeight: maxTrayHeight,
                             setTray: { open, page, haptic in setTray(open, page: page, haptic: haptic) })
                    .zIndex(2)

                // Floats in ZStack because safeAreaBar would clip voice banner tap targets.
                if let voice = store.voice {
                    VStack(spacing: 8) {
                        if let pill = voice.pillRecording {
                            VoiceRecordingPill(voice: voice, recording: pill) {
                                store.select(pill.conversationID)
                            }
                        }
                        VoiceRecoveryBanner(voice: voice)
                    }
                    .padding(.bottom, composerReserve + 8)
                    .padding(.horizontal, 20)
                    .zIndex(2)
                }

                if showCopied {
                    CopiedToast()
                        .padding(.bottom, composerReserve + 12)
                        .transition(reduceMotion ? .opacity : .praxisPop)
                        .zIndex(3)
                }
            }
            .environment(\.sendLaunch, sendLaunch)
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
                // Our glass circle only; the bar's shared glass would wrap it in a second ring.
                .sharedBackgroundVisibility(.hidden)
                ToolbarItem(placement: .principal) {
                    Button {
                        setTray(true, page: .models)
                    } label: {
                        VStack(spacing: 1) {
                            Text(conversation?.displayTitle ?? "Praxis Chat")
                                .font(Type.inter(15, weight: .semibold, .body))
                                .foregroundStyle(Praxis.ink)
                                .lineLimit(1)
                                .contentTransition(.opacity)
                            Text(store.model.name)
                                .font(Type.inter(11, .caption2))
                                .foregroundStyle(Praxis.mutedInk)
                                .contentTransition(.opacity)
                        }
                        .animation(Motion.snap, value: store.model.name)
                    }
                    .buttonStyle(PressScaleStyle())
                    .accessibilityLabel("Conversation, \(conversation?.displayTitle ?? ConversationTitle.placeholder), model \(store.model.name)")
                    .accessibilityHint("Opens model picker")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        store.haptics.fire(.light)
                        withAnimation(reduceMotion ? Motion.reduced : Motion.reveal) { store.newChat() }
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
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
                withAnimation(Motion.reflow) { keyboardUp = true }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
                withAnimation(Motion.reflow) { keyboardUp = false }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .background { store.voice?.appDidEnterBackground() }
            }
            .onChange(of: store.selectedID) { _, _ in
                store.voice?.refreshRecoverables()
            }
            .photosPicker(isPresented: $showPhotos, selection: $photoItems, matching: .images)
            .onChange(of: photoItems) { _, items in
                // Clear picker selection immediately after capturing items so it never leaks across chats.
                guard !items.isEmpty else { return }
                photoItems = []
                loadPhotos(items)
            }
            .onChange(of: store.selectedID) { photoItems = [] }
            .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                if case .success(let urls) = result {
                    withAnimation(Motion.reflow) {
                        for url in urls { store.attachments.append(Self.fileAttachment(url)) }
                    }
                    if !urls.isEmpty { setTray(false) }
                }
            }
            .fullScreenCover(isPresented: $showCamera) {
                CameraPicker { image in
                    if let data = image.jpegData(compressionQuality: 0.8) {
                        store.attachments.append(Attachment(kind: .camera, name: "Camera photo", imageData: data))
                    }
                    setTray(false)
                }
                .ignoresSafeArea()
            }
            .sheet(isPresented: $showHistory) { HistorySheet() }
            .sheet(isPresented: Bindable(store).isSettingsPresented) { SettingsSheet() }
            .sheet(item: elicitationBinding) { pending in
                ElicitationSheet(pending: pending)
            }
            .sheet(item: consentBinding) { request in
                ConsentSheet(request: request)
            }
            .sheet(item: $filePreview) { name in FilePreviewSheet(name: name) }
            .sheet(item: $linkPreview) { url in LinkPreviewSheet(url: url) }
            .navigationDestination(item: $viewerAttachment) { att in
                PhotoViewer(attachment: att)
                    .navigationTransition(.zoom(sourceID: att.id, in: glassNS))
            }
            // Handles Live Activity/notification links; markdown tiles are intercepted by OpenURLAction.
            .onOpenURL { url in
                if let id = Self.chatDeepLinkConversationID(from: url) {
                    store.select(id)
                }
            }
        }
    }

    /// Setter is a no-op because the sheet resolves itself and current may already be the next item.
    private var elicitationBinding: Binding<ElicitationCenter.Pending?> {
        let center = store.elicitationCenter
        return Binding(get: { center?.current }, set: { _ in })
    }

    /// Non-Allow dismissal declines consent and restores the held draft.
    private var consentBinding: Binding<ConsentRequest?> {
        Binding(get: { store.pendingConsent }, set: { if $0 == nil { store.resolveConsent(allow: false) } })
    }

    /// Reads security-scoped picker URL (size-capped) for document sending or JS fs exposure.
    private static func fileAttachment(_ url: URL) -> Attachment {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        let data = size <= 25 << 20 ? try? Data(contentsOf: url, options: .mappedIfSafe) : nil
        let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
        return Attachment(kind: .file, name: url.lastPathComponent, fileData: data, mediaType: type)
    }

    /// Parses praxis-app://chat/<uuid>, returning nil for all other URLs; internal for tests.
    static func chatDeepLinkConversationID(from url: URL) -> UUID? {
        guard url.scheme?.lowercased() == "praxis-app",
              url.host()?.lowercased() == "chat",
              let first = url.pathComponents.dropFirst().first else { return nil }
        return UUID(uuidString: first)
    }

    /// Resets trayPage only on open; resetting on close flashes the main page during collapse.
    private func setTray(_ open: Bool, page: TrayPage = .main, haptic: Bool = true) {
        guard open != trayOpen else { return }
        if open { trayPage = page }
        if haptic { store.haptics.fire(open ? .light : .soft) }
        withAnimation(reduceMotion ? Motion.reduced : Motion.morph) { trayOpen = open }
    }

    private func loadPhotos(_ items: [PhotosPickerItem]) {
        // Capture target chat before async load so a chat switch deposits into its stashed draft.
        let target = store.selectedID
        Task {
            var fresh: [Attachment] = []
            for item in items {
                if let data = try? await item.loadTransferable(type: Data.self) {
                    fresh.append(Attachment(kind: .photo, name: "Photo", imageData: data))
                }
            }
            guard let target, !items.isEmpty else { return }
            var landed = false
            withAnimation(Motion.reflow) { landed = store.deposit(fresh, for: target) }
            if landed { setTray(false) }
        }
    }

    private func handleChip(_ action: ChipAction) {
        switch action {
        case .file(let name): filePreview = name
        case .link(let url): linkPreview = url
        case .copied:
            store.haptics.fire(.selection)
            withAnimation(reduceMotion ? Motion.reduced : Motion.pop) { showCopied = true }
            hideCopied?.cancel()
            hideCopied = Task {
                try? await Task.sleep(for: .seconds(1.2))
                guard !Task.isCancelled else { return }
                withAnimation(reduceMotion ? Motion.reduced : Motion.reveal) { showCopied = false }
            }
        }
    }
}

// MARK: Composer dock

/// Single morphing card preserving composer identity; open tray overlays without thread reflow.
private struct ComposerDock: View {
    @Environment(ChatStore.self) private var store
    let trayOpen: Bool
    @Binding var trayPage: TrayPage
    @Binding var showPhotos: Bool
    @Binding var showFiles: Bool
    @Binding var showCamera: Bool
    @Binding var viewerAttachment: Attachment?
    @Binding var reserve: CGFloat
    var namespace: Namespace.ID
    var screenCorners: ScreenCorners
    var keyboardUp: Bool
    var maxTrayHeight: CGFloat
    var setTray: (Bool, TrayPage, Bool) -> Void

    @State private var rowHeight: CGFloat = 56
    @State private var pull: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.sendLaunch) private var sendLaunch

    // MARK: Placement — concentric with the screen corners

    private var inset: CGFloat { screenCorners.concentricInset(for: Praxis.composerRadius) }

    private var bottomPadding: CGFloat {
        keyboardUp ? 8 : max(0, inset - screenCorners.bottomInset)
    }

    private var drop: CGFloat {
        keyboardUp ? 0 : max(0, screenCorners.bottomInset - inset)
    }

    private var cardShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: Praxis.composerRadius, style: .continuous)
    }

    var body: some View {
        GlassEffectContainer(spacing: 8) {
            VStack(spacing: 0) {
                if trayOpen {
                    PlusTray(page: $trayPage, showPhotos: $showPhotos, showFiles: $showFiles,
                             showCamera: $showCamera, maxHeight: maxTrayHeight, pull: $pull,
                             onDismiss: { haptic in setTray(false, .main, haptic) })
                        .transition(reduceMotion ? .opacity : .asymmetric(
                            insertion: .opacity.combined(with: .offset(y: 24))
                                .combined(with: .modifier(active: BlurModifier(radius: 6),
                                                          identity: BlurModifier(radius: 0))),
                            removal: .opacity.combined(with: .offset(y: 16))
                                .animation(Motion.exit)))
                }
                ComposerView(trayOpen: trayOpen, namespace: namespace,
                             onToggleTray: { setTray(!trayOpen, .main, true) },
                             onSend: send,
                             onAttachmentTap: { viewerAttachment = $0 },
                             onCamera: { showCamera = true },
                             showsGlass: false,
                             isModelSearch: trayOpen && trayPage == .models,
                             onModelSearchSubmit: submitModelSearch)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { rowHeight = $0 }
            }
            .praxisGlass(in: cardShape, interactive: !trayOpen)
            .scaleEffect(reduceMotion ? 1 : 1 - min(pull, 160) / 2600, anchor: .bottom)
            .padding(.horizontal, inset)
            .padding(.bottom, bottomPadding)
            .offset(y: drop)
        }
        .onChange(of: (rowHeight + bottomPadding).rounded(), initial: true) { _, value in
            reserve = value
        }
    }

    /// Runs without an animation transaction so inserted rows don't slide; sendRise handles bubble.
    private func send() {
        sendLaunch?.arm(turnID: store.nextTurnID)
        store.send(text: store.draft)
    }

    private func submitModelSearch() {
        guard let top = ModelSearch.filter(store.availableModels, query: store.modelQuery).first else { return }
        store.haptics.fire(.selection)
        withAnimation(Motion.snap) { store.model = top }
        store.modelQuery = ""
    }
}

// MARK: Transcript

/// Isolates 120Hz scroll state and splits turns into block rows so LazyVStack estimates hold.
private struct TranscriptView: View {
    @Environment(ChatStore.self) private var store
    let conversation: Conversation?
    let trayOpen: Bool
    let bottomReserve: CGFloat
    var onChipAction: (ChipAction) -> Void
    /// Only user scrolling clears this; sudden row height jumps must not count as scrolled up.
    @State private var isAtBottom = true
    @State private var userScrolling = false
    /// Throttles re-pins to prevent LazyVStack height re-estimates from bouncing endlessly.
    @State private var lastRepin = Date.distantPast
    @State private var showJump = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private struct EdgeState: Equatable {
        var atBottom: Bool
        var farFromBottom: Bool
    }

    private struct Tail: Equatable {
        var turnID: UUID?
        var isRunning: Bool
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                Group {
                    if let conv = conversation {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(TranscriptRow.rows(for: conv, store: store)) { row in
                                TranscriptRowView(row: row, onChipAction: onChipAction)
                                    .equatable()
                                    .padding(.top, row.top)
                                    // Identity transition avoids ghosting removed rows under rows sliding up over them.
                                    .transition(.identity)
                            }
                            // Replaces bottom padding so scrolling to this ID reaches the true end without snapping back.
                            Color.clear.frame(height: 32).id("transcript-bottom")
                        }
                        .padding(.horizontal, Praxis.margin)
                        .padding(.top, 16)
                        .frame(maxWidth: 680)
                        .frame(maxWidth: .infinity)
                        .environment(\.openURL, OpenURLAction { url in
                            ChipAction.handle(url, onChipAction)
                            return .handled
                        })
                    }
                }
            }
            // Overlay avoids stacking empty state under the first turn and distorting bubble scroll/fade.
            .overlay {
                if conversation?.turns.isEmpty ?? true {
                    EmptyStateView()
                        .transition(.asymmetric(insertion: .opacity.animation(Motion.reveal),
                                                removal: .opacity.animation(Motion.exit)))
                }
            }
            // Resets scroll position per conversation so switching chats lands at the bottom.
            .id(conversation?.id)
            .transition(.opacity)
            .safeAreaPadding(.bottom, bottomReserve)
            // ScrollView anchors bottom growth while pinned and top on scroll-up; avoids per-chunk scrollTo.
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .defaultScrollAnchor(.bottom, for: .alignment)
            .defaultScrollAnchor(isAtBottom ? .bottom : .top, for: .sizeChanges)
            .scrollDismissesKeyboard(.interactively)
            .scrollEdgeEffectStyle(.soft, for: .top)
            .scrollEdgeEffectStyle(.soft, for: .bottom)
            .onScrollGeometryChange(for: EdgeState.self) { geo in
                let distance = geo.contentSize.height - (geo.contentOffset.y + geo.containerSize.height)
                return EdgeState(atBottom: distance < 260, farFromBottom: distance > 700)
            } action: { _, state in
                if state.atBottom {
                    isAtBottom = true
                } else if userScrolling {
                    isAtBottom = false
                } else if isAtBottom, Date().timeIntervalSince(lastRepin) > 0.25 {
                    lastRepin = Date()
                    pinToBottom(proxy)
                    return
                }
                if showJump != state.farFromBottom {
                    withAnimation(reduceMotion ? Motion.reduced : Motion.pop) { showJump = state.farFromBottom }
                }
            }
            .onScrollPhaseChange { _, phase in
                userScrolling = phase == .interacting || phase == .decelerating
            }
            .onChange(of: Tail(turnID: conversation?.turns.last?.id,
                               isRunning: conversation?.turns.last?.isRunning ?? false)) { old, new in
                guard new.isRunning, new.turnID != old.turnID || !old.isRunning else { return }
                pinToBottom(proxy)
            }
            .overlay(alignment: .bottom) {
                if showJump && !trayOpen {
                    jumpButton(proxy)
                        .padding(.bottom, bottomReserve + 12)
                        .transition(reduceMotion ? .opacity : .praxisPop)
                }
            }
        }
    }

    /// Jumps un-animated; animated scroll chases unmeasured LazyVStack estimates past old turns.
    private func pinToBottom(_ proxy: ScrollViewProxy) {
        isAtBottom = true
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            proxy.scrollTo("transcript-bottom", anchor: .bottom)
        }
    }

    private func jumpButton(_ proxy: ScrollViewProxy) -> some View {
        Button {
            store.haptics.fire(.light)
            isAtBottom = true
            withAnimation(reduceMotion ? Motion.reduced : Motion.reflow) {
                proxy.scrollTo("transcript-bottom", anchor: .bottom)
            }
        } label: {
            Image(systemName: "arrow.down")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Praxis.ink)
                .frame(width: 36, height: 36)
                .contentShape(Circle())
        }
        .buttonStyle(PressScaleStyle(scale: 0.9))
        .praxisGlass(in: Circle())
        .accessibilityLabel("Jump to latest")
    }
}

private struct EmptyStateView: View {
    var body: some View {
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
}

extension String: @retroactive Identifiable {
    public var id: String { self }
}

extension URL: @retroactive Identifiable {
    public var id: String { absoluteString }
}

private struct FlowSuggestions: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false

    var body: some View {
        VStack(spacing: 10) {
            ForEach(Array(MockData.suggestions.enumerated()), id: \.element) { index, suggestion in
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
                .opacity(appeared ? 1 : 0)
                .offset(y: appeared || reduceMotion ? 0 : 10)
                .animation(reduceMotion ? Motion.reduced : Motion.pop.delay(0.05 + Double(index) * 0.04),
                           value: appeared)
            }
        }
        .onAppear { appeared = true }
    }
}

/// Row IDs stay stable across streaming, close, and relaunch by keying on block and index.
private struct TranscriptRow: Identifiable, Equatable {
    enum ID: Hashable {
        case user(UUID), activity(UUID), text(UUID, Int), note(UUID), actions(UUID), compaction(UUID)
    }

    enum Content {
        case user(Turn)
        case activity(turnID: UUID, ActivityData)
        case text(MDBlockItem, selectable: Bool)
        case live(LiveText, index: Int)
        case note(Turn, canContinue: Bool)
        case actions(Turn)
        case compaction(CompactionMarker)
    }

    let id: ID
    let top: CGFloat
    let content: Content
    /// Only newest turn rows fade in; older history rows appear immediately when scrolled into view.
    let fades: Bool

    /// Compares only rendered row inputs so token streaming never re-renders sibling rows.
    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        guard lhs.id == rhs.id, lhs.top == rhs.top, lhs.fades == rhs.fades else { return false }
        switch (lhs.content, rhs.content) {
        case (.user(let a), .user(let b)):
            return CloudDocumentChips.sameUserPresentation(a, b)
        case (.activity(let at, let a), .activity(let bt, let b)):
            return at == bt && a == b
        case (.text(let a, let sa), .text(let b, let sb)):
            return a == b && sa == sb
        case (.live(let a, let ia), .live(let b, let ib)):
            return a === b && ia == ib
        case (.note(let a, let ca), .note(let b, let cb)):
            return a.outcome == b.outcome && ca == cb
        case (.actions(let a), .actions(let b)):
            return a.id == b.id && a.feedback == b.feedback && a.userText == b.userText
        case (.compaction(let a), .compaction(let b)):
            return a == b
        default:
            return false
        }
    }

    /// Reads each LiveText's blockCount rather than text so streaming re-runs once per paragraph.
    @MainActor
    static func rows(for conv: Conversation, store: ChatStore) -> [TranscriptRow] {
        var rows: [TranscriptRow] = []
        let turns = conv.turns
        for (n, turn) in turns.enumerated() {
            let fades = n == turns.count - 1
            let gap = Praxis.bubbleToAnswer
            rows.append(TranscriptRow(id: .user(turn.id), top: n == 0 ? 0 : Praxis.turnGap,
                                      content: .user(turn), fades: fades))
            for block in turn.blocks {
                switch block {
                case .activity(let activity):
                    rows.append(TranscriptRow(id: .activity(activity.id), top: gap,
                                              content: .activity(turnID: turn.id, activity), fades: fades))
                case .compaction(let marker):
                    rows.append(TranscriptRow(id: .compaction(marker.id), top: gap, content: .compaction(marker), fades: fades))
                case .markdown(let id, let source, let isStreaming):
                    // Closed blocks keep rendering from LiveText so finishing never swaps views or replays fade.
                    if let live = store.liveText(for: id) {
                        for index in 0..<live.blockCount {
                            rows.append(TranscriptRow(id: .text(id, index), top: gap,
                                                      content: .live(live, index: index), fades: fades))
                        }
                    } else {
                        for item in MarkdownCache.document(for: source).blocks {
                            rows.append(TranscriptRow(id: .text(id, item.id), top: gap,
                                                      content: .text(item, selectable: !isStreaming), fades: fades))
                        }
                    }
                }
            }
            if turn.isFinished, turn.outcome?.note != nil {
                let canContinue = turn.outcome == .pausedBackground && n == turns.count - 1
                    && !store.isRunning(conv.id)
                rows.append(TranscriptRow(id: .note(turn.id), top: gap, content: .note(turn, canContinue: canContinue),
                                          fades: fades))
            }
            if turn.isFinished && !turn.blocks.isEmpty {
                rows.append(TranscriptRow(id: .actions(turn.id), top: gap, content: .actions(turn), fades: fades))
            }
        }
        return rows
    }
}

/// Equatable ignores action closures so token streaming doesn't re-render every visible row.
private struct TranscriptRowView: View, Equatable {
    @Environment(ChatStore.self) private var store
    let row: TranscriptRow
    var onChipAction: (ChipAction) -> Void = { _ in }
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.sendLaunch) private var sendLaunch

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.row == rhs.row }

    var body: some View {
        content.frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var content: some View {
        switch row.content {
        case .user(let turn):
            UserBubble(turn: turn,
                       onEdit: { withAnimation(Motion.reflow) { store.edit(turnID: turn.id) } },
                       onResend: { store.resend(turnID: turn.id) },
                       riseFrom: sendLaunch?.origin(for: turn.id))
        case .activity(let turnID, let activity):
            AgentActivityView(activity: activity, turnID: turnID) { expanded in
                store.haptics.fire(.selection)
                withAnimation(reduceMotion ? Motion.reduced : Motion.reflow) {
                    store.setActivityExpanded(turnID: turnID, blockID: activity.id, expanded: expanded)
                }
            } onCommandToggle: { stepID, expanded in
                store.haptics.fire(.selection)
                withAnimation(reduceMotion ? Motion.reduced : Motion.reflow) {
                    store.setCommandExpanded(turnID: turnID, stepID: stepID, expanded: expanded)
                }
            } onApproval: { requestID, decision in
                withAnimation(reduceMotion ? Motion.reduced : Motion.reflow) {
                    store.resolveApproval(requestID, decision: decision)
                }
            }
            .equatable()
            .appearFade(row.fades)
        case .compaction(let marker):
            CompactionMarkerRow(marker: marker)
                .equatable()
                .appearFade(row.fades)
        case .text(let item, let selectable):
            MarkdownRowView(item: item, selectable: selectable, onChipAction: onChipAction)
                .equatable()
        case .live(let live, let index):
            LiveMarkdownRowView(live: live, index: index, onChipAction: onChipAction)
                .equatable()
        case .note(let turn, let canContinue):
            if turn.outcome == .needsProvider, let note = turn.outcome?.note {
                Button { store.isSettingsPresented = true } label: {
                    HStack(spacing: 6) {
                        Text(note).underline()
                        Image(systemName: "arrow.up.right").font(.system(size: 10, weight: .semibold))
                    }
                    .font(Type.inter(13, .caption))
                    .foregroundStyle(Praxis.secondaryInk)
                }
                .buttonStyle(PressScaleStyle())
                .accessibilityLabel("Open Settings to add a model provider")
                .appearFade(row.fades)
            } else if let note = turn.outcome?.note {
                VStack(spacing: 6) {
                    Text(note)
                        .font(Type.inter(13, .caption))
                        .foregroundStyle(Praxis.mutedInk)
                    // Continue gate lives in TranscriptRow so Equatable diffs detect when the last turn pauses.
                    if canContinue, let selectedID = store.selectedID {
                        Button { store.continueRun(conversationID: selectedID) } label: {
                            Text("Continue")
                                .font(Type.inter(13, weight: .semibold, .caption))
                                .foregroundStyle(Praxis.ink)
                        }
                        .buttonStyle(PressScaleStyle())
                        .accessibilityLabel("Continue")
                    }
                }
                .appearFade(row.fades)
            }
        case .actions(let turn):
            MessageActionRow(
                onCopy: {
                    let text = turn.blocks.compactMap {
                        if case .markdown(_, let s, _) = $0 { return s }; return nil
                    }.joined(separator: "\n\n")
                    UIPasteboard.general.string = text
                    onChipAction(.copied(text))
                },
                onRetry: {
                    withAnimation(reduceMotion ? Motion.reduced : Motion.reflow) { store.retry(turnID: turn.id) }
                },
                feedback: turn.feedback,
                onFeedback: { feedback in
                    store.haptics.fire(.selection)
                    withAnimation(Motion.snap) { store.setFeedback(turnID: turn.id, feedback: feedback) }
                },
                shareText: turn.userText
            )
            .appearFade(row.fades)
        }
    }
}

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
