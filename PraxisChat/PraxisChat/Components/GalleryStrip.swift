import SwiftUI

/// One photo-strip tile: the thumbnail (or a quiet placeholder while it
/// loads) with the selection checkmark. Same 56pt chrome as the camera tile.
struct GalleryThumb: View {
    let item: PhotoGallery.Item
    let selected: Bool
    var onTap: () -> Void = {}
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: onTap) {
            ZStack(alignment: .topTrailing) {
                Group {
                    if let thumbnail = item.thumbnail {
                        Image(uiImage: thumbnail).resizable().scaledToFill()
                    } else {
                        ZStack {
                            Praxis.fill1
                            Image(systemName: "photo")
                                .foregroundStyle(Praxis.mutedInk)
                        }
                    }
                }
                .frame(width: 56, height: 56)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(Praxis.hairline, lineWidth: 1))
                if selected {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(Praxis.ink, Praxis.canvas)
                        .padding(3)
                        .transition(reduceMotion ? .opacity : .scale(scale: 0.4).combined(with: .opacity))
                }
            }
            .scaleEffect(selected && !reduceMotion ? 0.92 : 1)
        }
        .buttonStyle(PressScaleStyle(scale: 0.94))
        .accessibilityLabel(item.name)
        .accessibilityValue(selected ? "Selected" : "Not selected")
    }
}

/// Limited Photos access: opens the system's "Manage" picker to allow more.
struct ManagePhotosTile: View {
    var onTap: () -> Void = {}

    var body: some View {
        Button(action: onTap) {
            VStack(spacing: 4) {
                Image(systemName: "photo.badge.plus").font(.system(size: 16))
                Text("Manage").font(Type.inter(10, weight: .medium, .caption2))
            }
            .foregroundStyle(Praxis.ink)
            .frame(width: 56, height: 56)
            .background(Praxis.fill1, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Praxis.hairline, lineWidth: 1))
        }
        .buttonStyle(PressScaleStyle(scale: 0.94))
        .accessibilityLabel("Manage photo access")
        .accessibilityHint("Choose which photos Praxis Chat can see")
    }
}

/// Denied Photos access: the strip's only tile, opening Settings.
struct AllowPhotosTile: View {
    var onTap: () -> Void = {}

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 8) {
                Image(systemName: "photo.badge.arrow.up").font(.system(size: 15))
                Text("Allow Photos access").font(Type.inter(13, weight: .medium, .footnote))
            }
            .foregroundStyle(Praxis.ink)
            .padding(.horizontal, 14)
            .frame(height: 56)
            .background(Praxis.fill1, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Praxis.hairline, lineWidth: 1))
        }
        .buttonStyle(PressScaleStyle(scale: 0.96))
        .accessibilityLabel("Allow Photos access")
        .accessibilityHint("Opens Settings to allow photo access")
    }
}
