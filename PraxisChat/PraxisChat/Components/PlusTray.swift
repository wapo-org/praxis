import SwiftUI
import AgentCore
import Photos
import UniformTypeIdentifiers
@preconcurrency import AVFoundation

/// Shares scroll pan for dismiss so inner scrolling never closes tray.
enum TrayPage { case main, models, connectors, prompts }

struct PlusTray: View {
    @Environment(ChatStore.self) private var store
    @Binding var page: TrayPage
    @Binding var showPhotos: Bool
    @Binding var showFiles: Bool
    @Binding var showCamera: Bool
    var maxHeight: CGFloat
    @Binding var pull: CGFloat
    var onDismiss: (Bool) -> Void

    @State private var contentHeight: CGFloat = 0
    /// Lags page state so outgoing page clears before incoming builds.
    @State private var shownPage: TrayPage?
    @State private var pageVisible = true
    @State private var pageRise: CGFloat = 0
    @State private var position = ScrollPosition(edge: .top)
    @State private var gallery = PhotoGallery()
    @State private var selectedShots: Set<UUID> = []
    @State private var appeared = false
    @State private var pastThreshold = false
    /// Only shows bottom blur band while rows overflow below.
    @State private var hasMoreBelow = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let dismissPull: CGFloat = 64

    private var trayHeight: CGFloat {
        contentHeight > 0 ? min(contentHeight, maxHeight) : maxHeight
    }

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
            // Fades out and swaps unseen to avoid crossfade double exposure.
            .opacity(pageVisible ? 1 : 0)
            .offset(y: pageRise)
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollPosition($position)
        .scrollEdgeEffectStyle(.soft, for: .bottom)
        .accessibilityIdentifier("plusTray")
        .frame(height: trayHeight)
        .animation(reduceMotion ? Motion.reduced : Motion.morph, value: trayHeight)
        // Clamp height upfront so lazy list re-estimates do not churn state.
        .onScrollGeometryChange(for: CGFloat.self) { min($0.contentSize.height, maxHeight + 1) } action: { _, h in
            contentHeight = h
        }
        // Only update pull when dragging past top so plain scrolling skips parent state.
        .onScrollGeometryChange(for: CGFloat.self) { geo in
            max(0, -(geo.contentOffset.y + geo.contentInsets.top)).rounded()
        } action: { _, distance in
            pull = distance
            let past = distance > Self.dismissPull
            if past != pastThreshold { pastThreshold = past }
        }
        // Boolean state flips only at threshold instead of per-frame scrolling.
        .onScrollGeometryChange(for: Bool.self) { geo in
            geo.contentSize.height - (geo.contentOffset.y + geo.containerSize.height) > 24
        } action: { _, more in
            hasMoreBelow = more
        }
        // Decide dismiss once on release to ignore momentum bounce.
        .onScrollPhaseChange { old, new, context in
            guard old == .interacting, new != .interacting else { return }
            let distance = -(context.geometry.contentOffset.y + context.geometry.contentInsets.top)
            if distance > Self.dismissPull { onDismiss(false) }
        }
        .sensoryFeedback(trigger: pastThreshold) { _, past in past ? .impact(weight: .light) : nil }
        .onChange(of: page) { _, _ in
            if page != .models { store.modelQuery = "" }
            switchPage()
        }
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
        // Manual progressive blur band since system edge effect misses card interior.
        .overlay(alignment: .bottom) {
            if hasMoreBelow {
                ProgressiveBlurScrim(edge: .bottom, length: 48, bands: 3, hold: 0.2, tint: 0)
                    .frame(maxWidth: .infinity)
                    .transition(.opacity)
            }
        }
        .animation(Motion.snap, value: hasMoreBelow)
        .onAppear { appeared = true; store.modelQuery = "" }
        .onDisappear { pull = 0 }
        .task { await gallery.loadIfNeeded() }
        .onChange(of: store.selectedID) { selectedShots = [] }
    }

    /// Swaps unseen because scroll view implicit animation overrides transition timing.
    private func switchPage() {
        store.haptics.fire(.selection)
        withAnimation(reduceMotion ? Motion.reduced : Motion.exit) {
            pageVisible = false
        } completion: {
            var swap = Transaction()
            swap.disablesAnimations = true
            withTransaction(swap) {
                shownPage = page
                pageRise = reduceMotion ? 0 : 8
                position.scrollTo(edge: .top)
            }
            withAnimation(reduceMotion ? Motion.reduced : Motion.reveal) {
                pageVisible = true
                pageRise = 0
            }
        }
    }

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

            if store.supportedEfforts != [] {
                VStack(alignment: .leading, spacing: 8) {
                    GlassSegmentedControl(
                        options: store.supportedEfforts ?? Effort.allCases, selection: store.effort,
                        title: { $0.title }
                    ) { store.effort = $0; store.haptics.fire(.selection) }
                    Text(store.effort.detail)
                        .font(Type.inter(13, .footnote))
                        .foregroundStyle(Praxis.mutedInk)
                        .contentTransition(.opacity)
                        .animation(Motion.snap, value: store.effort)
                }
                .modifier(stagger(2))
            }

            addSection
                .modifier(stagger(3))

            // Web search only if provider supports it; Memory stays demo-only.
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
                if !store.connectorPrompts.isEmpty || store.cloudServices?.connectors.contains(where: { $0.enabled }) == true {
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
                    // Capture target chat ID upfront in case user switches chats mid-attach.
                    let target = store.selectedID
                    Task {
                        guard let target, let shot = await gallery.latestScreenshot() else { return }
                        store.haptics.fire(.selection)
                        withAnimation(Motion.reflow) { _ = store.deposit([shot], for: target) }
                    }
                }
            }
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 8) {
                    LiveCameraTile { showCamera = true }
                    ForEach(gallery.items) { item in
                        let selected = selectedShots.contains(item.id)
                        GalleryThumb(item: item, selected: selected) {
                            store.haptics.fire(.selection)
                            if selected { selectedShots.remove(item.id) } else { selectedShots.insert(item.id) }
                        }
                    }
                    if gallery.access == .library(limited: true) {
                        ManagePhotosTile { gallery.presentLimitedPicker() }
                    }
                    if gallery.access == .denied {
                        AllowPhotosTile { gallery.openSettings() }
                    }
                }
                .padding(.horizontal, 4)
            }
            .frame(height: 64)

            if !selectedShots.isEmpty || gallery.adding != nil {
                Button {
                    attachSelected()
                } label: {
                    if let adding = gallery.adding {
                        PraxisButtonLabel("Adding \(min(adding.done + 1, adding.total))/\(adding.total)…",
                                          working: true)
                    } else {
                        PraxisButtonLabel("Add \(selectedShots.count)")
                            .contentTransition(.numericText())
                    }
                }
                .buttonStyle(.praxisPrimary(.compact))
                .disabled(gallery.adding != nil)
                .transition(reduceMotion ? .opacity : .praxisPop)
            }
        }
        .animation(reduceMotion ? Motion.reduced : Motion.pop, value: selectedShots)
    }

    /// Captures gallery and target chat ID so closing or switching never drops picks.
    private func attachSelected() {
        let ids = selectedShots
        selectedShots = []
        let target = store.selectedID
        Task {
            let chosen = await gallery.fullAttachments(for: ids)
            guard let target else { return }
            var landed = false
            withAnimation(Motion.reflow) { landed = store.deposit(chosen, for: target) }
            if landed { onDismiss(true) }
        }
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

    /// Scaled switch lets whole row serve as tap target.
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

    @ViewBuilder
    private var modelsPage: some View {
        if let cloud = store.cloudServices {
            VStack(alignment: .leading, spacing: 12) {
                trayHeader("Model") { page = .main }
                CloudCatalogModelList(services: cloud, selectedID: store.model.id) { model in
                    selectModel(cloud.adapter(model))
                }
                Button {
                    onDismiss(true)
                    store.isSettingsPresented = true
                } label: {
                    CloudSettingsRow(title: "Model providers", symbol: "gearshape")
                }.buttonStyle(PressHighlightStyle()).accessibilityLabel("Model providers")
            }
            .task(id: store.modelQuery) {
                do {
                    try await Task.sleep(for: .milliseconds(250))
                    try await cloud.searchModels(query: store.modelQuery)
                } catch is CancellationError { } catch { }
            }
        } else {
            nativeModelsPage
        }
    }

    private var nativeModelsPage: some View {
        VStack(alignment: .leading, spacing: 12) {
            trayHeader("Model") { page = .main }
            // Precompute section lookup once instead of O(n^2) per row.
            let sections = ModelSections.make(models: store.availableModels,
                                              pinnedIDs: store.pinnedModelIDs(),
                                              query: store.modelQuery)
            let pinned = Set(store.pinnedModelIDs())
            if !sections.favorites.isEmpty || !sections.unavailableIDs.isEmpty {
                favoritesHeader
                ModelList(models: sections.favorites + sections.unavailableIDs.map(Self.unavailableModel),
                          selectedID: store.model.id, emptyMessage: "",
                          onSelect: selectModel,
                          pinnedIDs: pinned, unavailableIDs: Set(sections.unavailableIDs),
                          onTogglePin: togglePin)
                .equatable()
            }
            let emptyMessage = modelsEmptyMessage(sections: sections)
            if !sections.rest.isEmpty || !emptyMessage.isEmpty {
                ModelList(models: sections.rest, selectedID: store.model.id,
                          emptyMessage: emptyMessage,
                          onSelect: selectModel,
                          pinnedIDs: pinned, unavailableIDs: [],
                          onTogglePin: togglePin)
                .equatable()
            }
            if store.services != nil || store.cloudServices != nil {
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

    private var favoritesHeader: some View {
        Text("Favorites")
            .font(Type.inter(13, weight: .semibold, .footnote))
            .foregroundStyle(Praxis.mutedInk)
            .padding(.horizontal, 14)
    }

    private static func unavailableModel(id: String) -> AIModel {
        AIModel(id: id, name: id, tagline: "Unavailable", speed: 0, intelligence: 0, streamMultiplier: 1)
    }

    private func modelsEmptyMessage(sections: ModelSections) -> String {
        if !ModelSearch.normalized(store.modelQuery).isEmpty {
            let found = !sections.favorites.isEmpty || !sections.unavailableIDs.isEmpty
            let query = store.modelQuery.trimmingCharacters(in: .whitespacesAndNewlines)
            return found ? "" : "No models match “\(query)”."
        }
        return store.services?.settings.hasProfiles == true
            ? "This provider listed no models. Enter a model ID in Settings."
            : "Add a model provider in Settings to chat with a real model."
    }

    private func selectModel(_ model: AIModel) {
        store.haptics.fire(.selection)
        withAnimation(Motion.snap) { store.model = model }
        store.modelQuery = ""
    }

    private func togglePin(_ model: AIModel) {
        let pinned = store.isModelPinned(model.id)
        store.haptics.fire(pinned ? .selection : .success)
        store.setModelPinned(model.id, pinned: !pinned)
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
                                          subtitle: connector.statusLabel.map { state in
                                              [state, store.connectorUpdateNote(connector.id)].compactMap { $0 }.joined(separator: " · ")
                                          } ?? store.connectorUpdateNote(connector.id),
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
            if store.services != nil || store.cloudServices != nil {
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

    private func lockedRow(_ connector: Connector, reason: String) -> some View {
        HStack(spacing: 10) {
            IntegrationAvatar(monogram: connector.monogram)
            VStack(alignment: .leading, spacing: 3) {
                Text(connector.name).font(Type.inter(15, .body)).foregroundStyle(Praxis.ink)
                if let status = connector.statusLabel { Text(status).font(Type.inter(12, .caption)).foregroundStyle(Praxis.mutedInk) }
            }
            Spacer()
            Text(reason).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(minHeight: 52)
        .opacity(0.6)
        .accessibilityElement(children: .combine)
    }

    /// Bind by ID rather than index so reorders never toggle the wrong connector.
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

}

/// Lazy equatable rows prevent stutter on large provider catalogs.
private struct ModelList: View, Equatable {
    let models: [AIModel]
    let selectedID: String
    let emptyMessage: String
    var onSelect: (AIModel) -> Void
    var pinnedIDs: Set<String> = []
    var unavailableIDs: Set<String> = []
    var onTogglePin: (AIModel) -> Void = { _ in }

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.selectedID == rhs.selectedID && lhs.emptyMessage == rhs.emptyMessage && lhs.models == rhs.models
            && lhs.pinnedIDs == rhs.pinnedIDs && lhs.unavailableIDs == rhs.unavailableIDs
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
                ModelRow(model: model, isSelected: model.id == selectedID, showsDivider: model.id != firstID,
                         onSelect: { onSelect(model) },
                         isPinned: pinnedIDs.contains(model.id),
                         isUnavailable: unavailableIDs.contains(model.id),
                         onTogglePin: { onTogglePin(model) })
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
    var isPinned: Bool = false
    var isUnavailable: Bool = false
    var onTogglePin: () -> Void = {}
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.model == rhs.model && lhs.isSelected == rhs.isSelected && lhs.showsDivider == rhs.showsDivider
            && lhs.isPinned == rhs.isPinned && lhs.isUnavailable == rhs.isUnavailable
    }

    var body: some View {
        VStack(spacing: 0) {
            if showsDivider {
                Rectangle().fill(Praxis.hairline).frame(height: 1)
                    .padding(.leading, 44)
            }
            Button(action: { if !isUnavailable { onSelect() } }) {
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
            .contextMenu {
                Button(isPinned ? "Unpin" : "Pin to Favorites") { onTogglePin() }
            }
        }
        .opacity(isUnavailable ? 0.55 : 1)
    }
}

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

/// Shows placeholder on Simulator or unauthorized access without prompting.
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

/// Reuses single background capture session to avoid 100-300ms setup lag.
final class CameraPreviewSession: @unchecked Sendable {
    static let shared = CameraPreviewSession()

    /// Caches device lookup once; re-checks permission dynamically.
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
