import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

/// Chat screen (spec §5): glass toolbar, transcript under progressive
/// scrims, composer in `safeAreaBar`, jump-to-latest, plus tray overlay.
///
/// Render isolation: this view only owns presentation state. Scroll
/// geometry lives in `TranscriptView` and streamed tokens are observed per
/// conversation, so neither scrolling nor streaming re-renders the toolbar,
/// the composer or the tray.
struct ChatScreen: View {
    @Environment(ChatStore.self) private var store
    @Namespace private var glassNS
    @State private var sendLaunch = SendLaunch()
    // `-PraxisOpenTray YES` (screenshots): launch with the tray open.
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
    /// Height the closed composer occupies above the bottom safe area; the
    /// transcript reserves exactly this, whether or not the tray is open.
    @State private var composerReserve: CGFloat = 72
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var conversation: Conversation? { store.selected }

    /// The tray grows to its content up to ~60% of the screen, then
    /// scrolls inside the card.
    private var maxTrayHeight: CGFloat { min(540, max(260, screenHeight * 0.6)) }

    var body: some View {
        NavigationStack {
            ZStack(alignment: .bottom) {
                Praxis.canvas.ignoresSafeArea()
                    .background(ScreenCornerReader(corners: $screenCorners))
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { screenHeight = $0 }

                TranscriptView(conversation: conversation, trayOpen: trayOpen,
                               bottomReserve: composerReserve, onChipAction: handleChip)

                // Progressive scrims (§3): full strength under the toolbar
                // (title + model name, ~105pt from the top edge) and the
                // composer, feathering out ~50pt past them. No visible edge.
                VStack {
                    ProgressiveBlurScrim(edge: .top, length: 160, maxRadius: 18, hold: 0.52)
                    Spacer()
                    ProgressiveBlurScrim(edge: .bottom, length: 150, maxRadius: 18, hold: 0.36)
                }
                .ignoresSafeArea(edges: [.top, .bottom])
                .allowsHitTesting(false)

                // Open tray behaves like a menu: a tap or drag anywhere on
                // the transcript closes it.
                if trayOpen {
                    Color.clear
                        .contentShape(Rectangle())
                        .ignoresSafeArea()
                        .onTapGesture { setTray(false) }
                        .gesture(DragGesture(minimumDistance: 12).onEnded { _ in setTray(false) })
                        .accessibilityHidden(true)
                }

                // The dock floats over the transcript instead of living in a
                // safe-area bar: the open tray must grow past the composer
                // row and stay hit-testable, and a bar only hit-tests (and
                // exposes to accessibility) what fits inside its own frame.
                ComposerDock(trayOpen: trayOpen, trayPage: $trayPage,
                             showPhotos: $showPhotos, showFiles: $showFiles, showCamera: $showCamera,
                             viewerAttachment: $viewerAttachment, reserve: $composerReserve,
                             namespace: glassNS,
                             screenCorners: screenCorners, keyboardUp: keyboardUp,
                             maxTrayHeight: maxTrayHeight,
                             setTray: { open, page, haptic in setTray(open, page: page, haptic: haptic) })
                    .zIndex(2)

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
                // Our glass circle only: the bar's shared glass would
                // wrap it in a second ring.
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
            .photosPicker(isPresented: $showPhotos, selection: $photoItems, matching: .images)
            .onChange(of: photoItems) { _, items in
                // The items are captured by value for the load; the picker's
                // own selection clears at once so it never carries over to
                // another chat (or a second open in this one).
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
        }
    }

    /// The first queued MCP elicitation. The sheet resolves its own
    /// request (swiping it away cancels it), so the setter has nothing to
    /// do — by the time it runs, `current` may already be the next one.
    private var elicitationBinding: Binding<ElicitationCenter.Pending?> {
        let center = store.services?.elicitations
        return Binding(get: { center?.current }, set: { _ in })
    }

    /// A live send held for AI-data consent. Dismissing the sheet any
    /// way other than Allow declines (the draft comes back).
    private var consentBinding: Binding<ConsentRequest?> {
        Binding(get: { store.pendingConsent }, set: { if $0 == nil { store.resolveConsent(allow: false) } })
    }

    /// A picked file with its bytes (capped; picker URLs are
    /// security-scoped), so the live engine can send it as a document
    /// or expose it to JS `fs`.
    private static func fileAttachment(_ url: URL) -> Attachment {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        let data = size <= 25 << 20 ? try? Data(contentsOf: url, options: .mappedIfSafe) : nil
        let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
        return Attachment(kind: .file, name: url.lastPathComponent, fileData: data, mediaType: type)
    }

    /// Single entry point for opening/closing the tray, so the haptic,
    /// spring and page reset are identical from every trigger. The page
    /// resets on open, never during the close (that flashed the main page
    /// into a collapsing card).
    private func setTray(_ open: Bool, page: TrayPage = .main, haptic: Bool = true) {
        guard open != trayOpen else { return }
        if open { trayPage = page }
        if haptic { store.haptics.fire(open ? .light : .soft) }
        withAnimation(reduceMotion ? Motion.reduced : Motion.morph) { trayOpen = open }
    }

    private func loadPhotos(_ items: [PhotosPickerItem]) {
        Task {
            for item in items {
                if let data = try? await item.loadTransferable(type: Data.self) {
                    withAnimation(Motion.reflow) {
                        store.attachments.append(Attachment(kind: .photo, name: "Photo", imageData: data))
                    }
                }
            }
            if !items.isEmpty { setTray(false) }
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

/// One glass card that morphs: composer when closed, tray content +
/// composer row when open — never two cards, and the composer row keeps
/// its identity (focus, recording state) across the morph.
///
/// The transcript only ever reserves the closed composer's height. The
/// open tray grows upward over the transcript instead of resizing its
/// safe area, which used to re-lay out the whole thread on open/close.
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

    /// The card's 28pt corners share their centre with the display
    /// corner, so the gap is equal along the sides, bottom and curve.
    private var inset: CGFloat { screenCorners.concentricInset(for: Praxis.composerRadius) }

    /// The bottom safe area already lifts the card by the home-indicator
    /// inset; pad or drop the remainder so the visible bottom gap equals
    /// the side inset. Over the keyboard it simply floats 8pt above.
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
                             showsGlass: false)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { rowHeight = $0 }
            }
            .praxisGlass(in: cardShape, interactive: !trayOpen)
            // Pulling the tray down squishes the card toward the composer
            // row — the dismiss gesture feels physical before it commits.
            .scaleEffect(reduceMotion ? 1 : 1 - min(pull, 160) / 2600, anchor: .bottom)
            .padding(.horizontal, inset)
            .padding(.bottom, bottomPadding)
            .offset(y: drop)
        }
        .onChange(of: (rowHeight + bottomPadding).rounded(), initial: true) { _, value in
            reserve = value
        }
    }

    /// No animation transaction: rows inserted or re-laid out by the
    /// send must not animate (they slid and flew). Only the new bubble
    /// moves, rising from the field (`sendRise`); the composer's own
    /// morphs (send → stop, strip collapsing) carry their own animations.
    private func send() {
        sendLaunch?.arm(turnID: store.nextTurnID)
        store.send(text: store.draft)
    }
}

// MARK: Transcript

/// Owns everything scroll-related so 120Hz geometry updates stay local.
/// Geometry is reduced to two booleans before it touches state: the
/// action only runs when a threshold is crossed, not on every frame.
///
/// Rows are blocks, not turns: the user bubble, each activity, each
/// markdown block (paragraph, list, code…), the note and the action row
/// are separate lazy rows. Whole-turn rows were 1–2K pt tall, and the
/// lazy stack's estimates for the ones it hadn't drawn swung by hundreds
/// of points — enough to land a send's scroll mid-thread and to slide
/// rows over each other while it corrected.
private struct TranscriptView: View {
    @Environment(ChatStore.self) private var store
    let conversation: Conversation?
    let trayOpen: Bool
    /// Space the floating composer covers at the bottom.
    let bottomReserve: CGFloat
    var onChipAction: (ChipAction) -> Void
    /// Following the bottom. Only the reader's own scrolling turns this
    /// off: a block row landing at once (a whole paragraph, a collapsing
    /// activity) can momentarily put the bottom far away, and that must
    /// not count as "scrolled up".
    @State private var isAtBottom = true
    @State private var userScrolling = false
    /// When following last re-pinned: at most a few per second, so a
    /// lazy re-estimate after a pin can't bounce the two forever.
    @State private var lastRepin = Date.distantPast
    @State private var showJump = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private struct EdgeState: Equatable {
        var atBottom: Bool
        var farFromBottom: Bool
    }

    /// The thread's last turn and whether it runs: a run starting there
    /// (send, resend, retry) brings the thread home.
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
                                    // No row transitions: a sent bubble rises as a
                                    // render effect (`sendRise`) and streamed rows
                                    // fade as one (`appearFade`). Removals are
                                    // instant: a fading row ghosted under the rows
                                    // sliding up over it.
                                    .transition(.identity)
                            }
                            // The true end of the content (it replaces the old
                            // bottom padding): scrolling to it can never land
                            // short of the real bottom and get snapped back.
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
            // The empty state lives over the scroll view, never inside its
            // content: as content it stacked under the first turn while it
            // faded, inflating the height so the new bubble dipped and
            // the old title ghosted through it.
            .overlay {
                if conversation?.turns.isEmpty ?? true {
                    EmptyStateView()
                        .transition(.asymmetric(insertion: .opacity.animation(Motion.reveal),
                                                removal: .opacity.animation(Motion.exit)))
                }
            }
            // A fresh scroll view per conversation: switching chats lands
            // at the bottom of the new thread, not at the old offset.
            .id(conversation?.id)
            .transition(.opacity)
            .safeAreaPadding(.bottom, bottomReserve)
            // Following the stream is the scroll view's own job: content
            // growth keeps the bottom pinned while the reader is there, and
            // keeps the text still (top anchor) once they scroll up. No
            // per-chunk scrollTo — those fought the anchor and jiggled.
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
                    // Content outran the bottom anchor while following.
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

    /// Lands on the bottom at once, outside the send's animation: an
    /// animated scroll through rows the lazy stack hasn't measured chased
    /// a moving target and showed older turns on the way.
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

/// Suggestion capsules (Thin glass, §5): tapping one sends it.
private struct FlowSuggestions: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false

    var body: some View {
        VStack(spacing: 10) {
            ForEach(Array(MockData.suggestions.enumerated()), id: \.element) { index, suggestion in
                Button {
                    // The empty state fades on its own; the first bubble
                    // just lands (no transaction to fly rows around).
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
                // Capsules cascade in when the empty state appears.
                .opacity(appeared ? 1 : 0)
                .offset(y: appeared || reduceMotion ? 0 : 10)
                .animation(reduceMotion ? Motion.reduced : Motion.pop.delay(0.05 + Double(index) * 0.04),
                           value: appeared)
            }
        }
        .onAppear { appeared = true }
    }
}

/// One lazy transcript row. Ids are stable across streaming, finishing
/// and relaunch: a markdown block's rows are keyed by the block and the
/// paragraph's position in it, whether they render from the live text or
/// the cached parse.
private struct TranscriptRow: Identifiable, Equatable {
    enum ID: Hashable {
        case user(UUID), activity(UUID), text(UUID, Int), note(UUID), actions(UUID), compaction(UUID)
    }

    enum Content {
        case user(Turn)
        case activity(turnID: UUID, ActivityData)
        case text(MDBlockItem, selectable: Bool)
        case live(LiveText, index: Int)
        case note(Turn)
        case actions(Turn)
        case compaction(CompactionMarker)
    }

    let id: ID
    /// Gap above the row: a turn gap before each bubble, the in-turn
    /// rhythm everywhere else.
    let top: CGFloat
    let content: Content
    /// Rows of the newest turn fade in when they appear; older turns'
    /// rows are history being scrolled back into view.
    let fades: Bool

    /// Equal when what the row draws is equal: a streamed token or a
    /// sibling's change re-renders no other row.
    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        guard lhs.id == rhs.id, lhs.top == rhs.top, lhs.fades == rhs.fades else { return false }
        switch (lhs.content, rhs.content) {
        case (.user(let a), .user(let b)):
            return a.id == b.id && a.userText == b.userText && a.attachments == b.attachments
        case (.activity(let at, let a), .activity(let bt, let b)):
            return at == bt && a == b
        case (.text(let a, let sa), .text(let b, let sb)):
            return a == b && sa == sb
        case (.live(let a, let ia), .live(let b, let ib)):
            return a === b && ia == ib
        case (.note(let a), .note(let b)):
            return a.outcome == b.outcome
        case (.actions(let a), .actions(let b)):
            return a.id == b.id && a.feedback == b.feedback && a.userText == b.userText
        case (.compaction(let a), .compaction(let b)):
            return a == b
        default:
            return false
        }
    }

    /// The thread as rows. Reads each live block's `blockCount` (not its
    /// text), so streaming re-runs this once per new paragraph.
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
                    // Streamed blocks keep rendering from their LiveText
                    // after they close, so finishing never swaps the rows
                    // (or replays the reveal).
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
                rows.append(TranscriptRow(id: .note(turn.id), top: gap, content: .note(turn), fades: fades))
            }
            if turn.isFinished && !turn.blocks.isEmpty {
                rows.append(TranscriptRow(id: .actions(turn.id), top: gap, content: .actions(turn), fades: fades))
            }
        }
        return rows
    }
}

/// One row: bubble, activity, markdown block, outcome note or the quiet
/// action row (§5/§8/§9). Equatable on the row: the closure never compares
/// equal, which used to re-render every visible row on every streamed token.
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
                       // Not animated, like a send: the new turn's rows
                       // land at once and the thread jumps to them.
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
                // One transaction for the card, its row's clip and
                // every row below, so they move as one.
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
        case .note(let turn):
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
                Text(note)
                    .font(Type.inter(13, .caption))
                    .foregroundStyle(Praxis.mutedInk)
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
