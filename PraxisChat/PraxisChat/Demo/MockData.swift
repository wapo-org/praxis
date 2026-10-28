import Foundation
import SwiftUI

/// Mock catalogue (spec §7). Everything here is demo data; every control
/// bound to it applies live through `ChatStore`.
enum MockData {
    static let models: [AIModel] = catalogue + extraModels(UserDefaults.standard.integer(forKey: "PraxisDemoModels"))

    private static let catalogue: [AIModel] = [
        AIModel(id: "atlas-pro", name: "Atlas Pro", tagline: "Deepest reasoning",
                speed: 2, intelligence: 5, streamMultiplier: 0.8),
        AIModel(id: "atlas", name: "Atlas", tagline: "Balanced for everyday work",
                speed: 3, intelligence: 4, streamMultiplier: 1.0),
        AIModel(id: "atlas-mini", name: "Atlas Mini", tagline: "Fastest answers",
                speed: 5, intelligence: 3, streamMultiplier: 1.6, effortLevels: [.low, .medium, .high]),
        AIModel(id: "atlas-code", name: "Atlas Code", tagline: "Tuned for large refactors",
                speed: 3, intelligence: 4, streamMultiplier: 1.1),
        AIModel(id: "atlas-chat", name: "Atlas Chat", tagline: "Quick chat, no reasoning",
                speed: 5, intelligence: 2, streamMultiplier: 1.8, effortLevels: []),
    ]

    /// `-PraxisDemoModels N` (UI/perf tests): a provider-sized list, like
    /// the hundreds of models OpenRouter returns.
    private static func extraModels(_ count: Int) -> [AIModel] {
        (0..<max(count, 0)).map { i in
            AIModel(id: "vendor/model-\(i)", name: String(format: "Vendor Model %03d", i),
                    tagline: "Demo provider · \(32 << (i % 4))K context", speed: 0, intelligence: 0,
                    streamMultiplier: 1)
        }
    }

    static let connectors: [Connector] = [
        Connector(id: "superblocks", name: "Superblocks", monogram: "S", isOn: true),
        Connector(id: "github", name: "GitHub", monogram: "G", isOn: true),
        Connector(id: "linear", name: "Linear", monogram: "L", isOn: false),
        Connector(id: "notion", name: "Notion", monogram: "N", isOn: false),
        Connector(id: "slack", name: "Slack", monogram: "S", isOn: false),
        Connector(id: "figma", name: "Figma", monogram: "F", isOn: false),
    ]

    static let suggestions = [
        "Add haptics to buttons",
        "Audit glass contrast",
        "Research progressive blur",
        "Why is my build failing?",
    ]

    /// Bundled fallback screenshots (spec §7): rendered swatches used when
    /// Photos access is denied. 12 calm monochrome tiles, rendered once —
    /// the tray used to redraw and PNG-encode all 12 on every open.
    static func sampleScreenshots() -> [Attachment] { cachedSamples }

    private static let cachedSamples: [Attachment] = (1...12).map { i in
        Attachment(kind: .screenshot, name: "Screenshot \(i)", imageData: sampleImageData(seed: i))
    }

    private static func sampleImageData(seed: Int) -> Data? {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 120, height: 220))
        let img = renderer.image { ctx in
            let hue = CGFloat(seed) / 12
            UIColor(hue: 0.1, saturation: 0.08, brightness: 0.35 + hue * 0.5, alpha: 1).setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 120, height: 220))
            UIColor.white.withAlphaComponent(0.25).setFill()
            for row in 0..<6 {
                let w: CGFloat = 96 - CGFloat((seed * (row + 3)) % 40)
                ctx.fill(CGRect(x: 12, y: CGFloat(20 + row * 32), width: w, height: 10))
            }
        }
        return img.pngData()
    }

    static func mockFileContents(name: String) -> String {
        """
        // \(name) — mock contents (Praxis Chat preview)
        import SwiftUI

        struct \(name.replacingOccurrences(of: ".swift", with: "")): View {
            var body: some View {
                Text("Preview")
                    .glassEffect(.regular.interactive(), in: .capsule)
            }
        }
        """
    }
}
