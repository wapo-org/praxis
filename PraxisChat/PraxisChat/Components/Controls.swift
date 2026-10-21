import SwiftUI
import UIKit

/// Glass segmented control with sliding thumb (§7): matchedGeometry,
/// selection haptic fired by the caller.
struct GlassSegmentedControl<Option: Identifiable & Equatable>: View {
    let options: [Option]
    let selection: Option
    var title: (Option) -> String
    var onSelect: (Option) -> Void
    @Namespace private var thumbNS
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options) { option in
                Button { onSelect(option) } label: {
                    Text(title(option))
                        .font(Type.inter(13, weight: .medium, .footnote))
                        .foregroundStyle(Praxis.ink)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background {
                            if selection == option {
                                Capsule(style: .continuous)
                                    .fill(Praxis.fill2)
                                    .matchedGeometryEffect(id: "thumb", in: thumbNS)
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(PressScaleStyle())
                .accessibilityLabel(title(option))
                .accessibilityValue(selection == option ? "Selected" : "")
            }
        }
        .padding(3)
        .praxisGlass(in: Capsule())
        .animation(reduceMotion ? .easeOut(duration: 0.12) : Motion.snap, value: selection)
    }
}

/// Speed / intelligence dot meter (§7).
struct DotMeter: View {
    let speed: Int
    let intelligence: Int
    var body: some View {
        HStack(spacing: 14) {
            meter("Speed", value: speed)
            meter("Intelligence", value: intelligence)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Speed \(speed) of 5, intelligence \(intelligence) of 5")
    }
    private func meter(_ label: String, value: Int) -> some View {
        HStack(spacing: 5) {
            Text(label).font(Type.inter(10, weight: .medium, .caption2)).foregroundStyle(Praxis.mutedInk)
            HStack(spacing: 3) {
                ForEach(1...5, id: \.self) { i in
                    Circle()
                        .fill(i <= value ? Praxis.ink : Praxis.hairline)
                        .frame(width: 5, height: 5)
                }
            }
        }
    }
}

/// IntegrationAvatar (§9.2): 16pt tile, 4pt radius, glyph Inter Semibold 9.
struct IntegrationAvatar: View {
    let monogram: String
    var body: some View {
        Text(monogram)
            .font(Type.inter(9, weight: .semibold, .caption2))
            .foregroundStyle(Praxis.tileGlyph)
            .frame(width: 16, height: 16)
            .background(Praxis.tile, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
            .accessibilityHidden(true)
    }
}

/// Camera via UIImagePickerController; disabled gracefully on Simulator
/// by the caller (spec §7).
struct CameraPicker: UIViewControllerRepresentable {
    var onImage: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = UIImagePickerController.isSourceTypeAvailable(.camera) ? .camera : .photoLibrary
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(parent: CameraPicker) { self.parent = parent }
        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.onImage(image) }
            parent.dismiss()
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}
