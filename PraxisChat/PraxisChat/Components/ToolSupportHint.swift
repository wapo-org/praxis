import SwiftUI

enum ToolSupportHint: Equatable {
    case noTools

    var text: String {
        switch self {
        case .noTools: return "This model can't use tools, so connectors and skills are off. Switch models to use them."
        }
    }

    var isWarning: Bool { true }
}

extension ChatStore {
    /// Only shown when live model is confirmed tool-less and user kept tools.
    var toolSupportHint: ToolSupportHint? {
        guard isLive, let services else { return nil }
        let settings = services.settings
        guard settings.selectedProfile != nil,
              settings.selectedProfile?.endpoint.capabilities.tools == true,
              settings.selectedToolSupport == .unsupported else { return nil }
        return .noTools
    }
}

struct ToolSupportHintRow: View {
    let hint: ToolSupportHint

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "wrench.and.screwdriver")
                .font(.system(size: 11, weight: .semibold))
            Text(hint.text)
                .font(Type.inter(12, .caption))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .foregroundStyle(Praxis.secondaryInk)
        .padding(.horizontal, 14)
        .padding(.top, 6)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("toolSupportHint")
        .transition(.opacity)
    }
}
