import Foundation
import Photos
import SwiftUI

/// The plus tray's photo strip (item 9): the user's most recent library
/// photos instead of placeholder tiles. Mocks survive only behind
/// `-PraxisMockGallery YES` (UI tests and previews).
@Observable
@MainActor
final class PhotoGallery {
    /// One strip tile: a library photo, or a mock under the mock gate.
    struct Item: Identifiable {
        /// Ephemeral key (a load's UUIDs are fresh each tray open);
        /// selection clears whenever the strip reloads.
        let id: UUID
        let name: String
        var thumbnail: UIImage?
        /// The library asset; nil for mocks.
        let asset: PHAsset?
        /// The mock attachment; nil for library photos.
        let mock: Attachment?
    }

    /// What the strip may show, from the Photos authorization.
    enum Access: Equatable {
        /// Not loaded yet.
        case unknown
        case loading
        /// Library photos; `limited` adds a "Manage" tile.
        case library(limited: Bool)
        /// A single "Allow Photos access" tile.
        case denied
    }

    /// A full-res attach in flight ("Adding 2/5…").
    struct Adding: Equatable {
        var done: Int
        var total: Int
        /// The current file's iCloud download fraction, 0…1.
        var fraction: Double
    }

    private(set) var items: [Item] = []
    private(set) var access: Access = .unknown
    private(set) var adding: Adding?

    private let imageManager = PHCachingImageManager()
    private var loaded = false
    private let changeObserver: ChangeObserver

    init() {
        let observer = ChangeObserver()
        self.changeObserver = observer
        observer.onChange = { [weak self] in
            Task { @MainActor [weak self] in self?.handleLibraryChange() }
        }
        PHPhotoLibrary.shared().register(observer)
    }

    deinit {
        PHPhotoLibrary.shared().unregisterChangeObserver(changeObserver)
    }

    /// Loads once per tray open (a fresh gallery each time, so new shots
    /// appear). Asks for Photos access on first open only: afterwards the
    /// status is determined and no prompt appears.
    func loadIfNeeded() async {
        guard !loaded else { return }
        loaded = true
        if UserDefaults.standard.bool(forKey: "PraxisMockGallery") {
            items = Self.mockItems()
            access = .library(limited: false)
            return
        }
        access = .loading
        var status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if status == .notDetermined {
            status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        }
        switch status {
        case .authorized:
            fetch(limited: false)
        case .limited:
            fetch(limited: true)
        default:
            access = .denied
        }
    }

    /// Maps a Photos authorization to what the strip shows. Pure, for tests.
    static func access(for status: PHAuthorizationStatus) -> Access {
        switch status {
        case .authorized: return .library(limited: false)
        case .limited: return .library(limited: true)
        default: return .denied
        }
    }

    /// The mock strip (UI tests, previews): the 12 rendered swatches with
    /// decoded thumbnails, so the strip renders one way for both sources.
    static func mockItems() -> [Item] {
        MockData.sampleScreenshots().map { attachment in
            Item(id: attachment.id, name: attachment.name,
                 thumbnail: attachment.imageData.flatMap { UIImage(data: $0) },
                 asset: nil, mock: attachment)
        }
    }

    /// The ~30 most recent images, newest first, with 64pt @3x thumbs.
    /// `fetchAssets` is lazy (cheap on the main actor); thumbnails and
    /// full bytes stream in through the image manager.
    private func fetch(limited: Bool) {
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.fetchLimit = 30
        let result = PHAsset.fetchAssets(with: .image, options: options)
        var fresh: [Item] = []
        fresh.reserveCapacity(result.count)
        for index in 0..<result.count {
            fresh.append(Item(id: UUID(), name: "Photo \(index + 1)", thumbnail: nil,
                              asset: result.object(at: index), mock: nil))
        }
        items = fresh
        access = .library(limited: limited)
        for item in fresh { requestThumbnail(for: item) }
    }

    /// Opportunistic delivery: a fast degraded thumb first, the crisp one
    /// when ready (each callback re-renders just its tile).
    private func requestThumbnail(for item: Item) {
        guard let asset = item.asset else { return }
        let options = PHImageRequestOptions()
        options.deliveryMode = .opportunistic
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = true
        let side = 64 * 3
        imageManager.requestImage(for: asset, targetSize: CGSize(width: side, height: side),
                                  contentMode: .aspectFill, options: options) { [weak self] image, _ in
            guard let image else { return }
            Task { @MainActor [weak self] in self?.setThumbnail(image, for: item.id) }
        }
    }

    private func setThumbnail(_ image: UIImage, for id: UUID) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        items[index].thumbnail = image
    }

    /// Full bytes for the chosen tiles, in strip order: mock tiles copy
    /// their staged bytes, library photos download (iCloud allowed, with
    /// progress) as the original file. Each attach gets a fresh id, so
    /// adding the same photo twice never duplicates composer-strip ids.
    func fullAttachments(for ids: Set<UUID>) async -> [Attachment] {
        let chosen = items.filter { ids.contains($0.id) }
        adding = Adding(done: 0, total: chosen.count, fraction: 0)
        var out: [Attachment] = []
        for item in chosen {
            if let data = await fullData(for: item) {
                out.append(Attachment(kind: .photo, name: item.name, imageData: data))
            }
            adding?.done += 1
            adding?.fraction = 0
        }
        adding = nil
        return out
    }

    /// The "Screenshot" quick tile: the newest shot in the screenshots
    /// album (mock gate: the first mock tile), attached directly — the
    /// strip itself is the mixed recent library, so its first tile is
    /// usually not a screenshot at all.
    func latestScreenshot() async -> Attachment? {
        if UserDefaults.standard.bool(forKey: "PraxisMockGallery") {
            guard let first = MockData.sampleScreenshots().first,
                  let data = first.imageData else { return nil }
            return Attachment(kind: .photo, name: first.name, imageData: data)
        }
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard status == .authorized || status == .limited else { return nil }
        let collection = PHAssetCollection.fetchAssetCollections(with: .smartAlbum,
                                                                 subtype: .smartAlbumScreenshots, options: nil)
        guard let album = collection.firstObject else { return nil }
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.fetchLimit = 1
        options.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
        guard let asset = PHAsset.fetchAssets(in: album, options: options).firstObject,
              let data = await fullData(for: asset) else { return nil }
        return Attachment(kind: .screenshot, name: "Screenshot", imageData: data)
    }

    private func fullData(for item: Item) async -> Data? {
        if let mock = item.mock { return mock.imageData }
        guard let asset = item.asset else { return nil }
        return await fullData(for: asset)
    }

    /// Original file bytes for one asset (iCloud allowed, with progress).
    private func fullData(for asset: PHAsset) async -> Data? {
        return await withCheckedContinuation { continuation in
            let options = PHImageRequestOptions()
            options.version = .current
            options.deliveryMode = .highQualityFormat
            options.isNetworkAccessAllowed = true
            options.progressHandler = { [weak self] progress, _, _, _ in
                Task { @MainActor [weak self] in self?.adding?.fraction = progress }
            }
            imageManager.requestImageDataAndOrientation(for: asset, options: options) { data, _, _, _ in
                continuation.resume(returning: data)
            }
        }
    }

    /// Limited access: let the user pick more photos from the system sheet.
    /// The change observer reloads the strip when they confirm.
    func presentLimitedPicker() {
        guard let window = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .flatMap(\.windows)
            .first(where: \.isKeyWindow),
            let root = window.rootViewController else { return }
        PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: root)
    }

    /// Denied access: the Settings app, where Photos can be re-allowed.
    func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    /// The library changed under us (new shot, limited-set edit): reload
    /// on the next pass. The prompt never re-fires — the status is
    /// determined by now.
    private func handleLibraryChange() {
        guard !UserDefaults.standard.bool(forKey: "PraxisMockGallery") else { return }
        loaded = false
        items = []
        Task { await loadIfNeeded() }
    }
}

/// Forwards library changes onto the gallery. The closure hops to the
/// main actor; nothing here touches gallery state directly.
private final class ChangeObserver: NSObject, PHPhotoLibraryChangeObserver, @unchecked Sendable {
    var onChange: (@Sendable () -> Void)?

    func photoLibraryDidChange(_ change: PHChange) {
        onChange?()
    }
}
