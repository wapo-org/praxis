import SwiftUI
import Photos
import UniformTypeIdentifiers
import AVFoundation

/// The plus tray (spec §7). It lives in the same glass container as the
/// composer and shares its `glassEffectID`, so opening it grows the
/// composer upward instead of presenting a separate floating card.
/// Swipe tracks the finger 1:1 and dismisses past a threshold.
enum TrayPage { case main, models, connectors }

struct PlusTray: View {
    @Environment(ChatStore.self) private var store
    @Binding var isOpen: Bool
    @Binding var page: TrayPage
    @Binding var showPhotos: Bool
    @Binding var showFiles: Bool
    @Binding var showCamera: Bool
    var namespace: Namespace.ID
    @State private var dragOffset: CGFloat = 0
    @State private var screenshots: [Attachment] = []
    @State private var selectedShots: Set<UUID> = []
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Content only: the caller wraps this together with the composer
    /// row in a single glass card, so the menu is the composer morphed,
    /// not a second card stacked on top of it. The content scrolls
    /// inside the card past a generous cap; the composer row below
    /// it never moves.
    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            Group {
                switch page {
                case .main: mainPage
                case .models: modelsPage
                case .connectors: connectorsPage
                }
            }
            // Page changes drift a few points up while crossfading —
            // no sideways push in either direction.
            .transition(reduceMotion ? .opacity : .asymmetric(
                insertion: .opacity.combined(with: .offset(y: 6)),
                removal: .opacity))
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 540)
        // Content dissolves into the card glass at the bottom
        // instead of being cut off abruptly above the composer row.
        .mask {
            LinearGradient(stops: [
                .init(color: .black, location: 0),
                .init(color: .black, location: 0.93),
                .init(color: .clear, location: 1.0),
            ], startPoint: .top, endPoint: .bottom)
        }
        // Pulling past the top of the card dismisses it — the scroll
        // view owns vertical drags, so the drag gesture alone starves.
        .onScrollGeometryChange(for: CGFloat.self) { geo in
            geo.contentOffset.y
        } action: { _, offsetY in
            if offsetY < -70 { dismiss() }
        }
        .animation(reduceMotion ? .easeOut(duration: 0.15) : Motion.morph, value: page)
        .offset(y: max(dragOffset, dragOffset < 0 ? dragOffset * 0.3 : dragOffset))
        .simultaneousGesture(dismissDrag)
        .onAppear { loadScreenshots() }
    }

    // MARK: Main page

    private var mainPage: some View {
        VStack(alignment: .leading, spacing: 14) {
            GlassSegmentedControl(
                options: ChatMode.allCases, selection: store.mode,
                title: { $0.title }
            ) { store.mode = $0; store.haptics.fire(.selection) }

            modelRow

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

            addSection

            groupedCard {
                toggleRow(symbol: "globe", title: "Web search", isOn: binding(\.webSearch))
                rowDivider
                toggleRow(symbol: "terminal", title: "Code execution", isOn: binding(\.codeExecution))
                rowDivider
                toggleRow(symbol: "brain", title: "Memory", isOn: binding(\.memory))
            }

            groupedCard {
                connectorsRow
            }
        }
    }

    private var modelRow: some View {
        Button {
            page = .models
        } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(store.model.name).font(Type.inter(15, weight: .semibold, .body)).foregroundStyle(Praxis.ink)
                    Text(store.model.tagline).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk)
                }
                Spacer()
                LucideIcon(name: "chevron-right", size: 14).foregroundStyle(Praxis.mutedInk)
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleStyle(scale: 0.99))
        .accessibilityLabel("Model, \(store.model.name)")
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
                Text("\(store.connectors.filter(\.isOn).count) on")
                    .font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk)
                LucideIcon(name: "chevron-right", size: 14).foregroundStyle(Praxis.mutedInk)
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleStyle(scale: 0.99))
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
                    if let first = screenshots.first { selectedShots.insert(first.id) }
                }
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
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
                    let chosen = screenshots.filter { selectedShots.contains($0.id) }
                    store.attachments.append(contentsOf: chosen)
                    selectedShots = []
                    dismiss()
                } label: {
                    Text("Add \(selectedShots.count)")
                        .font(Type.inter(14, weight: .semibold, .subheadline))
                        .foregroundStyle(Praxis.canvas)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 9)
                }
                .buttonStyle(.glassProminent)
                .tint(Praxis.ink)
                .transition(.scale(scale: 0.8).combined(with: .opacity))
            }
        }
        .animation(Motion.morph, value: selectedShots)
    }

    private func screenshotThumb(_ shot: Attachment) -> some View {
        Button {
            store.haptics.fire(.selection)
            if selectedShots.contains(shot.id) { selectedShots.remove(shot.id) }
            else { selectedShots.insert(shot.id) }
        } label: {
            ZStack(alignment: .topTrailing) {
                AttachmentThumbnail(attachment: shot, size: 56)
                if selectedShots.contains(shot.id) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(Praxis.ink, Praxis.canvas)
                        .padding(3)
                }
            }
        }
        .buttonStyle(PressScaleStyle(scale: 0.94))
        .accessibilityLabel(shot.name)
        .accessibilityValue(selectedShots.contains(shot.id) ? "Selected" : "Not selected")
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
        }
        .buttonStyle(PressScaleStyle())
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
    /// light, like the reference connector box.
    private func smallSwitch(title: String, isOn: Binding<Bool>) -> some View {
        Toggle(title, isOn: isOn)
            .labelsHidden()
            .toggleStyle(.switch)
            .tint(Praxis.ink)
            .scaleEffect(0.8)
            .frame(width: 44, height: 26)
            .accessibilityLabel(title)
    }

    private func toggleRow(symbol: String, title: String, subtitle: String? = nil,
                           isOn: Binding<Bool>) -> some View {
        HStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 14)).foregroundStyle(Praxis.mutedInk)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(Type.inter(15, .body)).foregroundStyle(Praxis.ink)
                if let subtitle {
                    Text(subtitle).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk)
                }
            }
            Spacer()
            smallSwitch(title: title, isOn: isOn)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
    }

    // MARK: Model page

    private var modelsPage: some View {
        VStack(alignment: .leading, spacing: 12) {
            trayHeader("Model") { page = .main }
            VStack(spacing: 0) {
                ForEach(Array(MockData.models.enumerated()), id: \.element.id) { index, model in
                    if index > 0 { rowDivider }
                    Button {
                        store.model = model
                        store.haptics.fire(.selection)
                    } label: {
                        HStack(spacing: 10) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(model.name).font(Type.inter(15, weight: .semibold, .body)).foregroundStyle(Praxis.ink)
                                Text(model.tagline).font(Type.inter(13, .footnote)).foregroundStyle(Praxis.mutedInk)
                                DotMeter(speed: model.speed, intelligence: model.intelligence)
                            }
                            Spacer()
                            if store.model.id == model.id {
                                Image(systemName: "checkmark").font(.system(size: 13, weight: .semibold)).foregroundStyle(Praxis.ink)
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .frame(minHeight: 52)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(PressScaleStyle(scale: 0.99))
                    .accessibilityLabel("\(model.name), \(model.tagline)")
                    .accessibilityValue(store.model.id == model.id ? "Selected" : "")
                }
            }
        }
    }

    // MARK: Connectors page

    private var connectorsPage: some View {
        VStack(alignment: .leading, spacing: 12) {
            trayHeader("Connectors") { page = .main }
            groupedCard {
                toggleRow(symbol: "square.grid.2x2", title: "Connector discovery",
                          subtitle: "Praxis will help you find available connectors in your directory.",
                          isOn: binding(\.connectorDiscovery))
            }
            groupedCard {
                ForEach(Array(store.connectors.enumerated()), id: \.element.id) { index, connector in
                    if index > 0 { rowDivider }
                    HStack(spacing: 10) {
                        IntegrationAvatar(monogram: connector.monogram)
                        Text(connector.name).font(Type.inter(15, .body)).foregroundStyle(Praxis.ink)
                        Spacer()
                        smallSwitch(title: connector.name,
                                    isOn: Binding(get: { store.connectors[index].isOn },
                                                  set: { store.connectors[index].isOn = $0 }))
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .frame(minHeight: 52)
                    .contentShape(Rectangle())
                }
            }
        }
    }

    private func trayHeader(_ title: String, back: @escaping () -> Void) -> some View {
        HStack(spacing: 8) {
            Button(action: back) {
                Image(systemName: "chevron.left").font(.system(size: 13, weight: .semibold))
                    .frame(width: 32, height: 32).contentShape(Circle())
            }
            .buttonStyle(PressScaleStyle())
            .praxisGlass(in: Circle())
            .accessibilityLabel("Back")
            Text(title).font(Type.inter(15, weight: .semibold, .body)).foregroundStyle(Praxis.ink)
            Spacer()
        }
    }

    // MARK: Behaviour

    private var dismissDrag: some Gesture {
        DragGesture()
            .onChanged { dragOffset = $0.translation.height }
            .onEnded { value in
                let velocity = value.velocity.height
                if dragOffset > 80 || velocity > 500 {
                    dismiss()
                } else {
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.85, blendDuration: 0)) { dragOffset = 0 }
                }
            }
    }

    private func dismiss() {
        store.haptics.fire(.soft)
        withAnimation(reduceMotion ? .easeOut(duration: 0.15) : Motion.morph) {
            isOpen = false
            dragOffset = 0
            page = .main
        }
    }

    private var isSimulator: Bool {
        #if targetEnvironment(simulator)
        true
        #else
        false
        #endif
    }

    private func loadScreenshots() {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if status == .authorized || status == .limited {
            let options = PHFetchOptions()
            options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
            options.fetchLimit = 12
            let collection = PHAssetCollection.fetchAssetCollections(with: .smartAlbum, subtype: .smartAlbumScreenshots, options: nil)
            if let album = collection.firstObject {
                let assets = PHAsset.fetchAssets(in: album, options: options)
                var loaded: [Attachment] = []
                assets.enumerateObjects { asset, _, _ in
                    loaded.append(Attachment(kind: .screenshot, name: asset.localIdentifier.prefix(8).description))
                }
                screenshots = loaded.isEmpty ? MockData.sampleScreenshots() : loaded
                return
            }
        }
        screenshots = MockData.sampleScreenshots()
    }
}

/// First gallery tile: live camera preview in the same rounded-square
/// chrome as every other attachment. On the Simulator (no camera) it
/// falls back to a camera glyph on the standard tile fill.
struct LiveCameraTile: View {
    var onTap: () -> Void = {}

    var body: some View {
        Button(action: onTap) {
            ZStack {
                Praxis.fill1
                CameraPreviewLayer()
                if AVCaptureDevice.default(for: .video) == nil {
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

private struct CameraPreviewLayer: UIViewRepresentable {
    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .clear
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device) else { return view }
        let session = AVCaptureSession()
        session.sessionPreset = .low
        if session.canAddInput(input) { session.addInput(input) }
        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = CGRect(x: 0, y: 0, width: 56, height: 56)
        view.layer.addSublayer(preview)
        context.coordinator.session = session
        DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {}

    static func dismantleUIView(_ view: UIView, coordinator: Coordinator) {
        coordinator.session?.stopRunning()
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        var session: AVCaptureSession?
    }
}
