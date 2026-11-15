import Foundation
import Photos
import SwiftUI

/// Recent library photo strip; mocks appear only when -PraxisMockGallery YES is set.
@Observable
@MainActor
final class PhotoGallery {
    struct Item: Identifiable {
        /// Ephemeral per-load UUID so selection resets whenever the strip reloads.
        let id: UUID
        let name: String
        var thumbnail: UIImage?
        let asset: PHAsset?
        let mock: Attachment?
    }

    enum Access: Equatable {
        case unknown
        case loading
        case library(limited: Bool)
        case denied
    }

    struct Adding: Equatable {
        var done: Int
        var total: Int
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

    /// Loads once per tray open; prompts for Photos access only while status is .notDetermined.
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

    static func access(for status: PHAuthorizationStatus) -> Access {
        switch status {
        case .authorized: return .library(limited: false)
        case .limited: return .library(limited: true)
        default: return .denied
        }
    }

    static func mockItems() -> [Item] {
        MockData.sampleScreenshots().map { attachment in
            Item(id: attachment.id, name: attachment.name,
                 thumbnail: attachment.imageData.flatMap { UIImage(data: $0) },
                 asset: nil, mock: attachment)
        }
    }

    /// PHAsset.fetchAssets is lazy on MainActor; thumbnails stream asynchronously via image manager.
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

    /// Exports chosen tiles in strip order with fresh IDs so re-attaching never collides.
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

    /// Queries the screenshots album directly since the recent strip holds mixed photos.
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

    func presentLimitedPicker() {
        guard let window = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .flatMap(\.windows)
            .first(where: \.isKeyWindow),
            let root = window.rootViewController else { return }
        PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: root)
    }

    func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    private func handleLibraryChange() {
        guard !UserDefaults.standard.bool(forKey: "PraxisMockGallery") else { return }
        loaded = false
        items = []
        Task { await loadIfNeeded() }
    }
}

/// Forwards PHPhotoLibrary changes via MainActor hop; never touches gallery state directly.
private final class ChangeObserver: NSObject, PHPhotoLibraryChangeObserver, @unchecked Sendable {
    var onChange: (@Sendable () -> Void)?

    func photoLibraryDidChange(_ change: PHChange) {
        onChange?()
    }
}
