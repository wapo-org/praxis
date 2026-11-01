import Foundation

public struct SSEEvent: Sendable, Equatable {
    public var event: String?
    public var data: String
    public var id: String?
    public init(event: String? = nil, data: String, id: String? = nil) {
        self.event = event
        self.data = data
        self.id = id
    }
}

/// Incremental byte-level Server-Sent Events parser.
///
/// Do not parse SSE with `URLSession.AsyncBytes.lines`: it drops empty
/// lines, and empty lines are the event delimiters. Feed raw chunks here
/// in any split — mid-line, mid-UTF-8 sequence, CRLF across chunks.
public struct SSEParser: Sendable {
    private var buffer: [UInt8] = []
    private var eventName: String?
    private var dataLines: [String] = []
    private var lastID: String?
    private var sawCR = false

    public init() {}

    public mutating func feed(_ chunk: Data) -> [SSEEvent] {
        var out: [SSEEvent] = []
        for byte in chunk {
            if sawCR {
                sawCR = false
                if byte == 0x0A { continue } // CRLF: the CR already ended the line
            }
            switch byte {
            case 0x0A:
                processLine(into: &out)
            case 0x0D:
                processLine(into: &out)
                sawCR = true
            default:
                buffer.append(byte)
            }
        }
        return out
    }

    /// Flushes a trailing event that wasn't followed by a blank line.
    public mutating func finish() -> [SSEEvent] {
        var out: [SSEEvent] = []
        if !buffer.isEmpty { processLine(into: &out) }
        dispatch(into: &out)
        return out
    }

    private mutating func processLine(into out: inout [SSEEvent]) {
        defer { buffer.removeAll(keepingCapacity: true) }
        if buffer.isEmpty {
            dispatch(into: &out)
            return
        }
        let line = String(decoding: buffer, as: UTF8.self)
        if line.hasPrefix(":") { return } // comment / keep-alive
        let field: Substring
        var value: Substring
        if let colon = line.firstIndex(of: ":") {
            field = line[..<colon]
            value = line[line.index(after: colon)...]
            if value.hasPrefix(" ") { value = value.dropFirst() }
        } else {
            field = Substring(line)
            value = ""
        }
        switch field {
        case "data": dataLines.append(String(value))
        case "event": eventName = String(value)
        case "id": if !value.contains("\0") { lastID = String(value) }
        default: break // `retry` and unknown fields are ignored
        }
    }

    private mutating func dispatch(into out: inout [SSEEvent]) {
        defer { eventName = nil; dataLines.removeAll(keepingCapacity: true) }
        guard !dataLines.isEmpty else { return }
        out.append(SSEEvent(event: eventName, data: dataLines.joined(separator: "\n"), id: lastID))
    }
}
