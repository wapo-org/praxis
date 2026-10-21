import SwiftUI

/// Bundled Lucide glyphs (spec §2): template vectors parsed from the
/// OFL/MIT Lucide SVGs in Resources/Lucide and drawn as stroked paths.
/// 24×24 grid, stroke 2, round caps/joins — rendered at any size.
struct LucideIcon: View {
    let name: String
    var size: CGFloat = 14

    var body: some View {
        LucideShape(name: name)
            .stroke(style: StrokeStyle(lineWidth: 2 * size / 24, lineCap: .round, lineJoin: .round))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

private struct LucideShape: Shape {
    let name: String
    func path(in rect: CGRect) -> Path {
        let scale = rect.width / 24
        var path = LucidePaths.path(for: name) ?? Path()
        path = path.applying(CGAffineTransform(scaleX: scale, y: scale))
        return path
    }
}

enum LucidePaths {
    // View-layer cache; shapes are only rasterized on the main thread.
    nonisolated(unsafe) private static var cache: [String: Path] = [:]

    static func path(for name: String) -> Path? {
        if let cached = cache[name] { return cached }
        guard let url = Bundle.main.url(forResource: name, withExtension: "svg", subdirectory: "Lucide")
            ?? Bundle.main.url(forResource: name, withExtension: "svg"),
              let svg = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let parsed = SVGPathParser.parse(svg: svg)
        cache[name] = parsed
        return parsed
    }
}

/// Minimal parser for Lucide's SVG subset: path (M/L/H/V/A/C/Z + relative),
/// line, circle, polyline, polygon.
enum SVGPathParser {
    static func parse(svg: String) -> Path {
        var path = Path()
        for match in matches(#"<path[^>]*\bd="([^"]+)""#, in: svg) {
            path.addPath(parsePathData(match.0))
        }
        // Lines, circles, polylines via attribute scan.
        for tag in matches(#"<(line|circle|polyline|polygon)[^>]*>"#, in: svg) {
            let kind = tag.0
            let attrs = attributes(tag.1)
            switch kind {
            case "line":
                if let x1 = attrs["x1"].flatMap(Double.init), let y1 = attrs["y1"].flatMap(Double.init),
                   let x2 = attrs["x2"].flatMap(Double.init), let y2 = attrs["y2"].flatMap(Double.init) {
                    path.move(to: CGPoint(x: x1, y: y1)); path.addLine(to: CGPoint(x: x2, y: y2))
                }
            case "circle":
                if let cx = attrs["cx"].flatMap(Double.init), let cy = attrs["cy"].flatMap(Double.init),
                   let r = attrs["r"].flatMap(Double.init) {
                    path.addEllipse(in: CGRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r))
                }
            case "polyline", "polygon":
                let nums = (attrs["points"] ?? "").split { !$0.isNumber && $0 != "." && $0 != "-" }
                    .compactMap { Double($0) }
                for i in stride(from: 0, to: nums.count - 1, by: 2) {
                    let p = CGPoint(x: nums[i], y: nums[i + 1])
                    if i == 0 { path.move(to: p) } else { path.addLine(to: p) }
                }
                if kind == "polygon" { path.closeSubpath() }
            default: break
            }
        }
        return path
    }

    private static func matches(_ pattern: String, in s: String) -> [(String, String)] {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return [] }
        let ns = s as NSString
        return re.matches(in: s, range: NSRange(location: 0, length: ns.length)).map { m in
            (m.numberOfRanges > 1 ? ns.substring(with: m.range(at: 1)) : "", ns.substring(with: m.range))
        }
    }

    private static func attributes(_ tag: String) -> [String: String] {
        var out: [String: String] = [:]
        guard let re = try? NSRegularExpression(pattern: #"(\w[\w-]*)="([^"]*)""#) else { return out }
        let ns = tag as NSString
        for m in re.matches(in: tag, range: NSRange(location: 0, length: ns.length)) where m.numberOfRanges == 3 {
            out[ns.substring(with: m.range(at: 1))] = ns.substring(with: m.range(at: 2))
        }
        return out
    }

    // MARK: Path-data parser (absolute + relative, incl. arcs)

    static func parsePathData(_ d: String) -> Path {
        var path = Path()
        let tokens = tokenize(d)
        var i = 0
        var cmd: Character = "M"
        var cur = CGPoint.zero
        var subStart = CGPoint.zero

        func nums(_ n: Int) -> [CGFloat] {
            var out: [CGFloat] = []
            while out.count < n, i < tokens.count, let v = tokens[i].number {
                out.append(v); i += 1
            }
            return out
        }

        while i < tokens.count {
            if let c = tokens[i].command { cmd = c; i += 1; if cmd == "Z" || cmd == "z" {
                path.closeSubpath(); cur = subStart; continue
            } }
            let rel = cmd.isLowercase
            switch Character(cmd.uppercased()) {
            case "M", "L":
                let v = nums(2); guard v.count == 2 else { return path }
                var p = CGPoint(x: v[0], y: v[1]); if rel { p.x += cur.x; p.y += cur.y }
                let isMove = (cmd == "M" || cmd == "m")
                if isMove { path.move(to: p); subStart = p; cmd = rel ? "l" : "L" } else { path.addLine(to: p) }
                cur = p
            case "H":
                let v = nums(1); guard v.count == 1 else { return path }
                var p = cur; p.x = rel ? cur.x + v[0] : v[0]
                path.addLine(to: p); cur = p
            case "V":
                let v = nums(1); guard v.count == 1 else { return path }
                var p = cur; p.y = rel ? cur.y + v[0] : v[0]
                path.addLine(to: p); cur = p
            case "C":
                let v = nums(6); guard v.count == 6 else { return path }
                func pt(_ a: CGFloat, _ b: CGFloat) -> CGPoint {
                    rel ? CGPoint(x: cur.x + a, y: cur.y + b) : CGPoint(x: a, y: b)
                }
                path.addCurve(to: pt(v[4], v[5]), control1: pt(v[0], v[1]), control2: pt(v[2], v[3]))
                cur = pt(v[4], v[5])
            case "A":
                let v = nums(7); guard v.count == 7 else { return path }
                var end = CGPoint(x: v[5], y: v[6]); if rel { end.x += cur.x; end.y += cur.y }
                let r = max(abs(v[0]), 0.001)
                // Endpoint → centre conversion (Lucide arcs are circular).
                let dx = (cur.x - end.x) / 2, dy = (cur.y - end.y) / 2
                let dist = max(hypot(dx, dy), 0.001)
                let h = sqrt(max(r * r - dist * dist, 0)) / dist
                let sign: CGFloat = (v[3] != v[4]) ? 1 : -1 // large-arc != sweep
                let center = CGPoint(x: (cur.x + end.x) / 2 + sign * h * dy,
                                     y: (cur.y + end.y) / 2 - sign * h * dx)
                let startAngle = atan2(cur.y - center.y, cur.x - center.x)
                let endAngle = atan2(end.y - center.y, end.x - center.x)
                path.addArc(center: center, radius: r,
                            startAngle: Angle(radians: Double(startAngle)),
                            endAngle: Angle(radians: Double(endAngle)),
                            clockwise: v[4] == 0)
                cur = end
            default:
                i += 1
            }
        }
        return path
    }

    private enum Tok { case command(Character); case number(CGFloat)
        var command: Character? { if case .command(let c) = self { return c }; return nil }
        var number: CGFloat? { if case .number(let v) = self { return v }; return nil }
    }

    private static func tokenize(_ d: String) -> [Tok] {
        var out: [Tok] = []
        var num = ""
        func flush() { if let v = Double(num) { out.append(.number(CGFloat(v))) }; num = "" }
        for ch in d {
            if ch.isLetter { flush(); out.append(.command(ch)) }
            else if ch.isNumber || ch == "." || ch == "-" {
                if ch == "-", !num.isEmpty { flush() }
                num.append(ch)
            } else { flush() }
        }
        flush()
        return out
    }
}
