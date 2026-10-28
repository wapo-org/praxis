import XCTest
@testable import PraxisChat

/// The variable-blur scrim's band math: layers must nest strictly toward
/// the edge (each deeper layer a shorter band), so the blur radius steps
/// up instead of fading out, and every mask must be a valid gradient.
final class ProgressiveBlurTests: XCTestCase {
    func testBandsNestStrictlyTowardTheEdge() {
        let reach = ProgressiveBlurScrim.bandReach(bands: 4, hold: 0.36)
        XCTAssertEqual(reach.count, 4)
        XCTAssertEqual(reach[0], 1, accuracy: 0.001)
        for i in 1..<reach.count {
            XCTAssertLessThan(reach[i], reach[i - 1])
            XCTAssertGreaterThan(reach[i], 0.36)
        }
    }

    func testInnermostBandStillCoversTheEdgeWithNoHold() {
        // hold == 0 must not produce a degenerate empty innermost layer.
        let reach = ProgressiveBlurScrim.bandReach(bands: 4, hold: 0)
        XCTAssertEqual(reach.count, 4)
        XCTAssertEqual(reach.last!, 0.25, accuracy: 0.001)
    }

    func testBandCountIsClamped() {
        XCTAssertEqual(ProgressiveBlurScrim.bandReach(bands: 0, hold: 0), [1])
        XCTAssertEqual(ProgressiveBlurScrim.bandReach(bands: 99, hold: 0).count, 6)
    }

    func testMaskStopsAreAValidFeather() {
        for reach in [1.0, 0.7, 0.4, 0.25] {
            let stops = ProgressiveBlurScrim.maskStops(reach: reach)
            XCTAssertEqual(stops.first?.location, 0)
            XCTAssertEqual(stops.first?.strength, 1)
            XCTAssertEqual(stops.last?.location ?? 0, reach, accuracy: 0.001)
            XCTAssertEqual(stops.last?.strength, 0)
            for i in 1..<stops.count {
                XCTAssertGreaterThanOrEqual(stops[i].location, stops[i - 1].location)
                XCTAssertLessThanOrEqual(stops[i].strength, stops[i - 1].strength)
            }
        }
    }

    func testProfileHoldsThenFeathersToZero() {
        let stops = ProgressiveBlurScrim.profile(hold: 0.5)
        XCTAssertEqual(stops.first?.location, 0)
        XCTAssertEqual(stops.first?.strength, 1)
        XCTAssertEqual(stops.last?.location, 1)
        XCTAssertEqual(stops.last?.strength, 0)
        for i in 1..<stops.count {
            XCTAssertGreaterThanOrEqual(stops[i].location, stops[i - 1].location)
            XCTAssertLessThanOrEqual(stops[i].strength, stops[i - 1].strength + 0.001)
        }
    }
}
