import SwiftUI
import AgentCore
import Photos
import UniformTypeIdentifiers
@preconcurrency import AVFoundation

/// The plus tray (spec §7). It lives in the same glass card as the
/// composer row, so opening it grows the composer upward instead of
/// presenting a separate floating card.
///
/// Scrolling and dismissal share one gesture — the scroll view's own pan:
/// pulling past the top squishes the card, ticks at the threshold, and
/// dismisses on release. There is no competing drag gesture, so scrolling
/// the connector list (in either direction) never moves or closes the tray.
enum TrayPage { case main, models, connectors, prompts }

struct PlusTray: View {
    @Environment(ChatStore.self) private var store
    @Binding var page: TrayPage
    @Binding var showPhotos: Bool
    @Binding var showFiles: Bool
    @Binding var showCamera: Bool
    /// Tallest the content may grow before it scrolls inside the card.
    var maxHeight: CGFloat
    /// How far the content is pulled past its top (0 when not pulled).
    @Binding var pull: CGFloat
    /// `true` = play the close haptic (the pull already ticked otherwise).
    var onDismiss: (Bool) -> Void

    @State private var contentHeight: CGFloat = 0
    /// Page actually drawn. Lags `page` during a switch so the outgoing
    /// page can clear before the incoming one is built — two pages are
    /// never on screen together.
    @State private var shownPage: TrayPage?
    @State private var pageVisible = true
    @State private var pageRise: CGFloat = 0
    @State private var position = ScrollPosition(edge: .top)
    @State private var screenshots: [Attachment] = MockData.sampleScreenshots()
    @State private var selectedShots: Set<UUID> = []
    @State private var appeared = false
    @State private var pastThreshold = false
    /// More rows lie below the viewport: the bottom blur band only
    /// shows then, so a settled list ends sharp.
    @State private var hasMoreBelow = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Pull distance that commits the dismiss on release.
    private static let dismissPull: CGFloat = 64

    private var trayHeight: CGFloat {
        contentHeight > 0 ? min(contentHeight, maxHeight) : maxHeight
    }

    /// Content only: the caller wraps this together with the composer
    /// row in a single glass card. The content scrolls inside the card
    /// past `maxHeight`; the composer row below it never moves.
    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            Group {
                switch shownPage ?? page {
                case .main: mainPage
                case .models: modelsPage
                case .connectors: connectorsPage
                case .prompts: ConnectorPromptsPage(onBack: { page = .main }, onInserted: { onDismiss(true) })
                }
            }
            // Page handoff (see `switchPage`): fade out, swap unseen, then
            // drift a few points up into place — no sideways push, no
            // crossfade double exposure.
            .opacity(pageVisible ? 1 : 0)
            .offset(y: pageRise)
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollPosition($position)
        .scrollEdgeEffectStyle(.soft, for: .bottom)
        .accessibilityIdentifier("plusTray")
        // Hug the content: short pages (Model) get a short card, and page
        // switches morph the card height instead of jumping.
        .frame(height: trayHeight)
        .animation(reduceMotion ? Motion.reduced : Motion.morph, value: trayHeight)
        // Clamped before it reaches state: a long lazy list re-estimates
        // its height while it scrolls, and only the card's height matters.
        .onScrollGeometryChange(for: CGFloat.self) { min($0.contentSize.height, maxHeight + 1) } action: { _, h in
            contentHeight = h
        }
        // Only reports while pulled past the top: plain scrolling inside
        // the list never touches parent state.
        .onScrollGeometryChange(for: CGFloat.self) { geo in
            max(0, -(geo.contentOffset.y + geo.contentInsets.top)).rounded()
        } action: { _, distance in
            pull = distance
            let past = distance > Self.dismissPull
            if past != pastThreshold { pastThreshold = past }
        }
        // A boolean, so it only touches state when the bottom band
        // must appear or disappear — never per frame while scrolling.
        .onScrollGeometryChange(for: Bool.self) { geo in
            geo.contentSize.height - (geo.contentOffset.y + geo.containerSize.height) > 24
        } action: { _, more in
            hasMoreBelow = more
        }
        // Dismiss is decided once, on release — not on every frame of an
        // overscroll, and never by a fling's momentum bounce.
        .onScrollPhaseChange { old, new, context in
            guard old == .interacting, new != .interacting else { return }
            let distance = -(context.geometry.contentOffset.y + context.geometry.contentInsets.top)
            if distance > Self.dismissPull { onDismiss(false) }
        }
        .sensoryFeedback(trigger: pastThreshold) { _, past in past ? .impact(weight: .light) : nil }
        .onChange(of: page) { _, _ in switchPage() }
        // Content dissolves into the card glass at the bottom instead of
        // being cut off abruptly above the composer row; the rounded top
        // keeps scrolled rows inside the card's corners.
        .mask {
            LinearGradient(stops: [
                .init(color: .black, location: 0),
                .init(color: .black, location: 0.93),
                .init(color: .clear, location: 1.0),
            ], startPoint: .top, endPoint: .bottom)
            .clipShape(UnevenRoundedRectangle(topLeadingRadius: Praxis.composerRadius,
                                              topTrailingRadius: Praxis.composerRadius,
                                              style: .continuous))
        }
        // Progressive blur where rows dive toward the composer row. The
        // system edge effect has no bar to work with inside the card, so
        // this band does it: untinted, since it floats over content.
        .overlay(alignment: .bottom) {
            if hasMoreBelow {
                ProgressiveBlurScrim(edge: .bottom, length: 48, bands: 3, hold: 0.2, tint: 0)
                    .frame(maxWidth: .infinity)
                    .transition(.opacity)
            }
        }
        .animation(Motion.snap, value: hasMoreBelow)
        .onAppear { appeared = true }
        .onDisappear { pull = 0 }
        .task { await loadScreenshots() }
    }

    /// Two-phase page change. A transition-based crossfade kept both pages
    /// half-visible for several frames (the scroll view's implicit page
    /// animation overrode the per-transition timing), so the swap happens
    /// while nothing is visible.
    private func switchPage() {
        store.haptics.fire(.selection)
        withAnimation(reduceMotion ? Motion.reduced : Motion.exit) {
            pageVisible = false
        } completion: {
            var swap = Transaction()
            swap.disablesAnimations = true
            withTransaction(swap) {
                shownPage = page // latest target, even after rapid taps
                pageRise = reduceMotion ? 0 : 8
                position.scrollTo(edge: .top)
            }
            withAnimation(reduceMotion ? Motion.reduced : Motion.reveal) {
                pageVisible = true
                pageRise = 0
            }
        }
    }

    /// Sections cascade in on open — a short stagger, so the card feels
    /// like it unfolds rather than appearing in one block.
    private func stagger(_ index: Int) -> some ViewModifier {
        StaggerIn(visible: appeared || reduceMotion, delay: 0.03 * Double(index))
    }

    // MARK: Main page

    private var mainPage: some View {
        VStack(alignment: .leading, spacing: 14) {
            GlassSegmentedControl(
                options: ChatMode.allCases, selection: store.mode,
                title: { $0.title }
            ) { store.mode = $0; store.haptics.fire(.selection) }
            .modifier(stagger(0))

            modelRow
                .modifier(stagger(1))

            VStack(alignment: .leading, spacing: 8) {
                GlassSegmentedControl(
                    options: Effort.allCases, selection: store.effort,
                    title: { $0.title }
                ) { store.effort = $0; store.haptics.fire(.selection) }
                Text(store.effort.detail)
                    .font(Type.inter(13, .footnote))
                    .foregroundStyle(Praxis.mutedInk)
                    .contentTransition(.opacity)
                    .animation(Motion.snap, value: store.effort)
            }
            .modifier(stagger(2))

            addSection
                .modifier(stagger(3))

            // Live: web search only where the provider hosts it; Memory is
            // a demo control (hidden in v1 of the real loop).
            if store.showsWebSearch || store.showsDemoToggles {
                groupedCard {
                    if store.showsWebSearch {
                        toggleRow(symbol: "globe", title: "Web search", isOn: binding(\.webSearch))
                    }
                    if store.showsWebSearch && store.showsDemoToggles { rowDivider }
                    if store.showsDemoToggles {
                        toggleRow(symbol: "brain", title: "Memory", isOn: binding(\.memory))
                    }
                }
                .modifier(stagger(4))
            }

            groupedCard {
                connectorsRow
                // Connector prompts (MCP), when the chat's connectors offer any.
                if !store.connectorPrompts.isEmpty {
                    rowDivider
                    promptsRow
                }
            }
            .task { await store.refreshConnectorPrompts() }
            .modifier(stagger(5))
        }
    }

    private var modelRow: some View {
        Button {
            page = .models
        } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(store.model.name).font(Type.inter(15, weight: .semibold, .body)).foregroundStyle(Praxis.ink)
                        .contentTransition(.opacity)
                    Text(store.model.tagline).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk)
                        .contentTransition(.opacity)
                }
                Spacer()
                LucideIcon(name: "chevron-right", size: 14).foregroundStyle(Praxis.mutedInk)
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressHighlightStyle())
        .accessibilityLabel("Model, \(store.model.name)")
    }

    private var promptsRow: some View {
        Button {
            page = .prompts
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "text.bubble")
                    .font(.system(size: 14)).foregroundStyle(Praxis.mutedInk)
                    .frame(width: 20)
                Text("Prompts").font(Type.inter(15, .body)).foregroundStyle(Praxis.ink)
                Spacer()
                Text("\(store.connectorPrompts.reduce(0) { $0 + $1.prompts.count })")
                    .font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk)
                LucideIcon(name: "chevron-right", size: 14).foregroundStyle(Praxis.mutedInk)
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressHighlightStyle(cornerRadius: 18))
        .accessibilityLabel("Connector prompts")
    }

    private var connectorsRow: some View {
        Button {
            page = .connectors
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "link")
                    .font(.system(size: 14)).foregroundStyle(Praxis.mutedInk)
                    .frame(width: 20)
                Text("Connectors").font(Type.inter(15, .body)).foregroundStyle(Praxis.ink)
                Spacer()
                Text("\(store.trayConnectors.filter(\.isOn).count) on")
                    .font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk)
                    .contentTransition(.numericText())
                LucideIcon(name: "chevron-right", size: 14).foregroundStyle(Praxis.mutedInk)
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressHighlightStyle(cornerRadius: 18))
        .accessibilityLabel("Connectors")
    }

    private var addSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                addTile("Photos", symbol: "photo.on.rectangle") { showPhotos = true }
                addTile("Camera", symbol: "camera") { showCamera = true }
                    .disabled(isSimulator)
                    .opacity(isSimulator ? 0.45 : 1)
                addTile("Files", symbol: "folder") { showFiles = true }
                addTile("Screenshot", symbol: "rectangle.on.rectangle") {
                    if let first = screenshots.first {
                        store.haptics.fire(.selection)
                        selectedShots.insert(first.id)
                    }
                }
            }
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 8) {
                    // First gallery item is the live camera preview;
                    // tapping it opens the camera to attach a photo.
                    LiveCameraTile { showCamera = true }
                    ForEach(screenshots) { shot in
                        screenshotThumb(shot)
                    }
                }
                .padding(.horizontal, 4)
            }
            .frame(height: 64)

            if !selectedShots.isEmpty {
                Button {
                    // Fresh identities: adding the same screenshot twice
                    // must not put duplicate IDs in the composer strip.
                    let chosen = screenshots.filter { selectedShots.contains($0.id) }
                        .map { Attachment(kind: $0.kind, name: $0.name, imageData: $0.imageData) }
                    withAnimation(Motion.reflow) { store.attachments.append(contentsOf: chosen) }
                    selectedShots = []
                    onDismiss(true)
                } label: {
                    PraxisButtonLabel("Add \(selectedShots.count)")
                        .contentTransition(.numericText())
                }
                .buttonStyle(.praxisPrimary(.compact))
                .transition(reduceMotion ? .opacity : .praxisPop)
            }
        }
        .animation(reduceMotion ? Motion.reduced : Motion.pop, value: selectedShots)
    }

    private func screenshotThumb(_ shot: Attachment) -> some View {
        let selected = selectedShots.contains(shot.id)
        return Button {
            store.haptics.fire(.selection)
            if selected { selectedShots.remove(shot.id) } else { selectedShots.insert(shot.id) }
        } label: {
            ZStack(alignment: .topTrailing) {
                AttachmentThumbnail(attachment: shot, size: 56)
                if selected {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(Praxis.ink, Praxis.canvas)
                        .padding(3)
                        .transition(reduceMotion ? .opacity : .scale(scale: 0.4).combined(with: .opacity))
                }
            }
            .scaleEffect(selected && !reduceMotion ? 0.92 : 1)
        }
        .buttonStyle(PressScaleStyle(scale: 0.94))
        .accessibilityLabel(shot.name)
        .accessibilityValue(selected ? "Selected" : "Not selected")
    }

    private func addTile(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: symbol).font(.system(size: 17))
                Text(title).font(Type.inter(11, weight: .medium, .caption2))
            }
            .foregroundStyle(Praxis.ink)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(PressScaleStyle(scale: 0.92))
        .praxisGlass(in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityLabel(title)
    }

    private func binding<T>(_ keyPath: ReferenceWritableKeyPath<ChatStore, T>) -> Binding<T> {
        Binding(get: { store[keyPath: keyPath] }, set: { store[keyPath: keyPath] = $0 })
    }

    // MARK: Grouped cards (connector-box look)

    private func groupedCard<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 0) { content() }
            .background(Praxis.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(Praxis.hairline, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private var rowDivider: some View {
        Rectangle().fill(Praxis.hairline).frame(height: 1)
            .padding(.leading, 44)
    }

    /// Compact switch: native control scaled down so the row stays
    /// light, like the reference connector box. The whole row toggles it,
    /// so the target isn't limited to the 40pt knob.
    private func smallSwitch(title: String, isOn: Binding<Bool>) -> some View {
        Toggle(title, isOn: isOn)
            .labelsHidden()
            .toggleStyle(.switch)
            .tint(Praxis.ink)
            .scaleEffect(0.8)
            .frame(width: 44, height: 26)
            .accessibilityLabel(title)
    }

    private func toggleRow(symbol: String? = nil, avatar: String? = nil, title: String,
                           subtitle: String? = nil, isOn: Binding<Bool>) -> some View {
        HStack(spacing: 10) {
            if let avatar {
                IntegrationAvatar(monogram: avatar)
            } else if let symbol {
                Image(systemName: symbol)
                    .font(.system(size: 14)).foregroundStyle(Praxis.mutedInk)
                    .frame(width: 20)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(Type.inter(15, .body)).foregroundStyle(Praxis.ink)
                if let subtitle {
                    Text(subtitle).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk)
                }
            }
            Spacer()
            smallSwitch(title: title, isOn: Binding(
                get: { isOn.wrappedValue },
                set: { new in
                    store.haptics.fire(.selection)
                    withAnimation(Motion.snap) { isOn.wrappedValue = new }
                }))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
        .onTapGesture {
            store.haptics.fire(.selection)
            withAnimation(Motion.snap) { isOn.wrappedValue.toggle() }
        }
    }

    // MARK: Model page

    private var modelsPage: some View {
        VStack(alignment: .leading, spacing: 12) {
            trayHeader("Model") { page = .main }
            // One read of the list and the selection per render: the
            // selection used to be looked up per row (O(n²) with a
            // provider's hundreds of models).
            ModelList(models: store.availableModels, selectedID: store.model.id,
                      emptyMessage: store.services?.settings.hasProfiles == true
                          ? "This provider listed no models. Enter a model ID in Settings."
                          : "Add a model provider in Settings to chat with a real model.") { model in
                store.haptics.fire(.selection)
                withAnimation(Motion.snap) { store.model = model }
            }
            .equatable()
            if store.services != nil {
                groupedCard {
                    Button {
                        onDismiss(true)
                        store.isSettingsPresented = true
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "gearshape")
                                .font(.system(size: 14)).foregroundStyle(Praxis.mutedInk)
                                .frame(width: 20)
                            Text("Model providers").font(Type.inter(15, .body)).foregroundStyle(Praxis.ink)
                            Spacer()
                            LucideIcon(name: "chevron-right", size: 14).foregroundStyle(Praxis.mutedInk)
                        }
                        .padding(.horizontal, 14)
                        .frame(minHeight: 52)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(PressHighlightStyle(cornerRadius: 18))
                    .accessibilityLabel("Model providers")
                }
            }
        }
    }

    // MARK: Connectors page

    private var connectorsPage: some View {
        VStack(alignment: .leading, spacing: 12) {
            trayHeader("Connectors") { page = .main }
            if store.showsDemoToggles {
                groupedCard {
                    toggleRow(symbol: "square.grid.2x2", title: "Connector discovery",
                              subtitle: "Praxis will help you find available connectors in your directory.",
                              isOn: binding(\.connectorDiscovery))
                }
            }
            let connectors = store.trayConnectors
            let laterOnly = store.newChatOnlyConnectors
            if connectors.isEmpty && laterOnly.isEmpty {
                Text("No connectors installed yet. Remote MCP servers you add will show up here.")
                    .font(Type.inter(13, .footnote))
                    .foregroundStyle(Praxis.mutedInk)
                    .padding(.horizontal, 4)
            } else {
                if !connectors.isEmpty {
                    groupedCard {
                        ForEach(connectors) { connector in
                            if connector.id != connectors.first?.id { rowDivider }
                            if let reason = connector.lockedReason {
                                lockedRow(connector, reason: reason)
                            } else {
                                toggleRow(avatar: connector.monogram, title: connector.name,
                                          subtitle: store.connectorUpdateNote(connector.id),
                                          isOn: connectorBinding(connector.id))
                            }
                        }
                    }
                }
                if store.connectorsFrozen {
                    Text("Turning one off here only affects this chat; its tools stay listed but won't run.")
                        .font(Type.inter(13, .footnote))
                        .foregroundStyle(Praxis.mutedInk)
                        .padding(.horizontal, 4)
                }
                if !laterOnly.isEmpty {
                    groupedCard {
                        ForEach(laterOnly) { connector in
                            if connector.id != laterOnly.first?.id { rowDivider }
                            lockedRow(connector, reason: connector.lockedReason ?? "")
                        }
                    }
                    Text("This chat's tools were set when it started. Start a new chat to use these.")
                        .font(Type.inter(13, .footnote))
                        .foregroundStyle(Praxis.mutedInk)
                        .padding(.horizontal, 4)
                }
            }
            if store.services != nil {
                groupedCard {
                    Button {
                        onDismiss(true)
                        store.settingsPage = .connectors
                        store.isSettingsPresented = true
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "gearshape")
                                .font(.system(size: 14)).foregroundStyle(Praxis.mutedInk)
                                .frame(width: 20)
                            Text("Manage connectors").font(Type.inter(15, .body)).foregroundStyle(Praxis.ink)
                            Spacer()
                            LucideIcon(name: "chevron-right", size: 14).foregroundStyle(Praxis.mutedInk)
                        }
                        .padding(.horizontal, 14)
                        .frame(minHeight: 52)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(PressHighlightStyle(cornerRadius: 18))
                    .accessibilityLabel("Manage connectors")
                }
            }
        }
    }

    /// A connector that can't be switched from here, with why.
    private func lockedRow(_ connector: Connector, reason: String) -> some View {
        HStack(spacing: 10) {
            IntegrationAvatar(monogram: connector.monogram)
            Text(connector.name).font(Type.inter(15, .body)).foregroundStyle(Praxis.ink)
            Spacer()
            Text(reason).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(minHeight: 52)
        .opacity(0.6)
        .accessibilityElement(children: .combine)
    }

    /// Bound by id, not index: a stale index after a reorder must never
    /// flip the wrong connector.
    private func connectorBinding(_ id: String) -> Binding<Bool> {
        Binding(
            get: { store.trayConnectors.first { $0.id == id }?.isOn ?? false },
            set: { new in store.setConnector(id, isOn: new) })
    }

    private func trayHeader(_ title: String, back: @escaping () -> Void) -> some View {
        HStack(spacing: 8) {
            Button(action: back) {
                Image(systemName: "chevron.left")
            }
            .buttonStyle(.praxisIcon(.compact))
            .accessibilityLabel("Back")
            Text(title).font(Type.inter(15, weight: .semibold, .body)).foregroundStyle(Praxis.ink)
            Spacer()
        }
    }

    // MARK: Behaviour

    private var isSimulator: Bool {
        #if targetEnvironment(simulator)
        true
        #else
        false
        #endif
    }

    /// Photos fetch runs off the main thread; the cached sample tiles show
    /// immediately, so the strip never pops in mid-animation.
    private func loadScreenshots() async {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard status == .authorized || status == .limited else { return }
        let names: [String] = await Task.detached(priority: .userInitiated) {
            let options = PHFetchOptions()
            options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
            options.fetchLimit = 12
            let collection = PHAssetCollection.fetchAssetCollections(with: .smartAlbum, subtype: .smartAlbumScreenshots, options: nil)
            guard let album = collection.firstObject else { return [] }
            let assets = PHAsset.fetchAssets(in: album, options: options)
            var names: [String] = []
            assets.enumerateObjects { asset, _, _ in names.append(String(asset.localIdentifier.prefix(8))) }
            return names
        }.value
        guard !names.isEmpty else { return }
        screenshots = names.map { Attachment(kind: .screenshot, name: $0) }
    }
}

/// The model page's list. Lazy: a provider can list hundreds of models,
/// and building every row (eagerly, on open and again on close) made the
/// tray stutter. Rows are equatable, so a selection redraws two of them.
private struct ModelList: View, Equatable {
    let models: [AIModel]
    let selectedID: String
    let emptyMessage: String
    var onSelect: (AIModel) -> Void

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.selectedID == rhs.selectedID && lhs.emptyMessage == rhs.emptyMessage && lhs.models == rhs.models
    }

    var body: some View {
        LazyVStack(spacing: 0) {
            if models.isEmpty {
                Text(emptyMessage)
                    .font(Type.inter(13, .footnote))
                    .foregroundStyle(Praxis.mutedInk)
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            let firstID = models.first?.id
            ForEach(models) { model in
                ModelRow(model: model, isSelected: model.id == selectedID, showsDivider: model.id != firstID) {
                    onSelect(model)
                }
                .equatable()
            }
        }
    }
}

private struct ModelRow: View, Equatable {
    let model: AIModel
    let isSelected: Bool
    let showsDivider: Bool
    var onSelect: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.model == rhs.model && lhs.isSelected == rhs.isSelected && lhs.showsDivider == rhs.showsDivider
    }

    var body: some View {
        VStack(spacing: 0) {
            if showsDivider {
                Rectangle().fill(Praxis.hairline).frame(height: 1)
                    .padding(.leading, 44)
            }
            Button(action: onSelect) {
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(model.name).font(Type.inter(15, weight: .semibold, .body)).foregroundStyle(Praxis.ink)
                        Text(model.tagline).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk)
                        if model.speed > 0 {
                            DotMeter(speed: model.speed, intelligence: model.intelligence)
                        }
                    }
                    Spacer()
                    if isSelected {
                        Image(systemName: "checkmark").font(.system(size: 13, weight: .semibold)).foregroundStyle(Praxis.ink)
                            .transition(reduceMotion ? .opacity : .scale(scale: 0.4).combined(with: .opacity))
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .frame(minHeight: 52)
                .contentShape(Rectangle())
            }
            .buttonStyle(PressHighlightStyle())
            .accessibilityLabel("\(model.name), \(model.tagline)")
            .accessibilityValue(isSelected ? "Selected" : "")
        }
    }
}

/// Fade + rise + blur-in with a per-section delay, driven by one flag.
private struct StaggerIn: ViewModifier {
    let visible: Bool
    let delay: Double
    func body(content: Content) -> some View {
        content
            .opacity(visible ? 1 : 0)
            .offset(y: visible ? 0 : 10)
            .blur(radius: visible ? 0 : 3)
            .animation(Motion.morph.delay(delay), value: visible)
    }
}

/// First gallery tile: live camera preview in the same rounded-square
/// chrome as every other attachment. On the Simulator (no camera) or
/// without camera permission it shows a camera glyph on the tile fill —
/// it never triggers a permission prompt just by opening the tray.
struct LiveCameraTile: View {
    var onTap: () -> Void = {}

    var body: some View {
        Button(action: onTap) {
            ZStack {
                Praxis.fill1
                if CameraPreviewSession.isAvailable {
                    CameraPreviewLayer()
                } else {
                    Image(systemName: "camera.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(Praxis.mutedInk)
                }
                Image(systemName: "camera")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(4)
                    .background(Color.black.opacity(0.35), in: Circle())
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                    .padding(4)
            }
            .frame(width: 56, height: 56)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Praxis.hairline, lineWidth: 1))
        }
        .buttonStyle(PressScaleStyle(scale: 0.94))
        .accessibilityLabel("Live camera preview")
    }
}

/// One shared low-preset capture session, started and stopped on its own
/// queue. Reopening the tray reuses it instead of building a new session
/// (100–300ms of main-thread-adjacent work) every time.
final class CameraPreviewSession: @unchecked Sendable {
    static let shared = CameraPreviewSession()

    /// Device discovery is slow, so it runs once; permission is re-read
    /// each time (it's a cheap lookup and can change while running).
    private static let hasDevice = AVCaptureDevice.default(for: .video) != nil
    static var isAvailable: Bool {
        hasDevice && AVCaptureDevice.authorizationStatus(for: .video) == .authorized
    }

    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "praxis.camera-preview")
    private var configured = false
    private var users = 0

    func acquire() {
        queue.async { [self] in
            users += 1
            if !configured {
                configured = true
                session.sessionPreset = .low
                if let device = AVCaptureDevice.default(for: .video),
                   let input = try? AVCaptureDeviceInput(device: device),
                   session.canAddInput(input) {
                    session.addInput(input)
                }
            }
            if !session.isRunning { session.startRunning() }
        }
    }

    func release() {
        queue.async { [self] in
            users = max(users - 1, 0)
            if users == 0 && session.isRunning { session.stopRunning() }
        }
    }
}

private struct CameraPreviewLayer: UIViewRepresentable {
    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.session = CameraPreviewSession.shared.session
        view.previewLayer.videoGravity = .resizeAspectFill
        CameraPreviewSession.shared.acquire()
        return view
    }

    func updateUIView(_ view: PreviewView, context: Context) {}

    static func dismantleUIView(_ view: PreviewView, coordinator: ()) {
        CameraPreviewSession.shared.release()
    }

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }
}
