import SwiftUI

/// Icon names observed in `ClaudeDesignSystem_ClaudeIcons.bundle`
/// (468 unique `anthropicon.*` names, 5,693 catalog records).
/// The proprietary glyphs are not copied; each name maps to the closest
/// SF Symbol so the layout, sizing, and states match without the assets.
enum AppIcon: String {
    case chat = "anthropicon.chat"
    case chatAdd = "anthropicon.chatAdd"
    case chats = "anthropicon.chats"
    case add = "anthropicon.add"
    case addCircle = "anthropicon.addCircle"
    case arrowUp = "anthropicon.arrowUp"
    case arrowRight = "anthropicon.arrowRight"
    case check = "anthropicon.check"
    case copy = "anthropicon.copy"
    case camera = "anthropicon.camera"
    case attachment = "anthropicon.attachment"
    case code = "anthropicon.code"
    case artifacts = "anthropicon.artifacts"
    case search = "anthropicon.magnifyingGlass"
    case settings = "anthropicon.sliders"
    case mic = "anthropicon.microphone"
    case stop = "anthropicon.stop"
    case chevronDown = "anthropicon.caretDown"
    case sidebar = "anthropicon.sidebar"
    case sparkle = "anthropicon.sparkle"
    case folder = "anthropicon.folder"
    case trash = "anthropicon.trash"
    case pencil = "anthropicon.pencil"
    case share = "anthropicon.share"
    case xmark = "anthropicon.close"

    var symbol: String {
        switch self {
        case .chat: return "message"
        case .chatAdd: return "plus.message"
        case .chats: return "message.on.message"
        case .add: return "plus"
        case .addCircle: return "plus.circle"
        case .arrowUp: return "arrow.up"
        case .arrowRight: return "arrow.right"
        case .check: return "checkmark"
        case .copy: return "doc.on.doc"
        case .camera: return "camera"
        case .attachment: return "paperclip"
        case .code: return "chevron.left.forwardslash.chevron.right"
        case .artifacts: return "square.on.square"
        case .search: return "magnifyingglass"
        case .settings: return "slider.horizontal.3"
        case .mic: return "mic"
        case .stop: return "stop.fill"
        case .chevronDown: return "chevron.down"
        case .sidebar: return "sidebar.left"
        case .sparkle: return "sparkles"
        case .folder: return "folder"
        case .trash: return "trash"
        case .pencil: return "pencil"
        case .share: return "square.and.arrow.up"
        case .xmark: return "xmark"
        }
    }

    func image(size: CGFloat = 18, weight: Font.Weight = .regular) -> some View {
        Image(systemName: symbol)
            .font(.system(size: size, weight: weight))
            .accessibilityLabel(rawValue)
    }
}

/// Haptic press feedback, after the observed `AnimatingHapticButton.swift`
/// and `LongPressButtonStyle` in ClaudeCoreUI (names observed; behaviour
/// re-implemented).
struct HapticButtonStyle: ButtonStyle {
    var scale: CGFloat = 0.96
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1)
            .animation(Tokens.springSnappy, value: configuration.isPressed)
            .onChange(of: configuration.isPressed) { _, pressed in
                if pressed {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                }
            }
    }
}
