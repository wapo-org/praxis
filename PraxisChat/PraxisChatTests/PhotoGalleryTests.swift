import Photos
import XCTest
@testable import PraxisChat

/// The tray's photo strip: authorization mapping, the mock strip behind
/// `-PraxisMockGallery`, and mock attach (the PhotoKit paths need a
/// library, so they are covered by screenshots, not unit tests).
@MainActor
final class PhotoGalleryTests: XCTestCase {
    func testAccessMapping() {
        XCTAssertEqual(PhotoGallery.access(for: .authorized), .library(limited: false))
        XCTAssertEqual(PhotoGallery.access(for: .limited), .library(limited: true))
        XCTAssertEqual(PhotoGallery.access(for: .denied), .denied)
        XCTAssertEqual(PhotoGallery.access(for: .restricted), .denied)
        XCTAssertEqual(PhotoGallery.access(for: .notDetermined), .denied)
    }

    func testMockItems() {
        let items = PhotoGallery.mockItems()
        XCTAssertEqual(items.count, 12)
        XCTAssertEqual(items.first?.name, "Screenshot 1")
        XCTAssertNotNil(items.first?.thumbnail, "mock tiles carry decoded thumbs")
        XCTAssertNil(items.first?.asset)
        XCTAssertNotNil(items.first?.mock)
    }

    func testLoadMockGallery() async {
        UserDefaults.standard.set(true, forKey: "PraxisMockGallery")
        addTeardownBlock { UserDefaults.standard.removeObject(forKey: "PraxisMockGallery") }
        let gallery = PhotoGallery()
        await gallery.loadIfNeeded()
        XCTAssertEqual(gallery.items.count, 12)
        XCTAssertEqual(gallery.access, .library(limited: false))
    }

    func testLatestScreenshotMockAttachesFirstTile() async {
        UserDefaults.standard.set(true, forKey: "PraxisMockGallery")
        addTeardownBlock { UserDefaults.standard.removeObject(forKey: "PraxisMockGallery") }
        let gallery = PhotoGallery()
        let shot = await gallery.latestScreenshot()
        XCTAssertEqual(shot?.name, "Screenshot 1")
        XCTAssertNotNil(shot?.imageData)
    }

    func testMockAttachCopiesBytesUnderFreshIDs() async {
        UserDefaults.standard.set(true, forKey: "PraxisMockGallery")
        addTeardownBlock { UserDefaults.standard.removeObject(forKey: "PraxisMockGallery") }
        let gallery = PhotoGallery()
        await gallery.loadIfNeeded()
        let id = gallery.items[0].id
        let atts = await gallery.fullAttachments(for: [id])
        XCTAssertEqual(atts.count, 1)
        XCTAssertEqual(atts[0].kind, .photo)
        XCTAssertNotNil(atts[0].imageData)
        XCTAssertNotEqual(atts[0].id, id, "the composer strip must not reuse gallery ids")
        XCTAssertNil(gallery.adding, "progress clears when the attach lands")
    }
}
