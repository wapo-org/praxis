import SwiftUI

/// History (reference: Claude Chats): glass circle chrome, airy rows
/// with a chat glyph and relative date, floating New chat pill over a
/// glass search bar, overflow menu for select / All / Pinned.
struct HistorySheet: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var filter: Filter = .all
    @State private var selecting = false
    @State private var selectedIDs: Set<UUID> = []

    private enum Filter { case all, pinned }

    private var visible: [Conversation] {
        store.conversations.filter { conv in
            (filter == .all || conv.isPinned)
                && (query.isEmpty || conv.title.localizedCaseInsensitiveContains(query))
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 26) {
                    ForEach(visible) { conv in
                        row(conv)
                    }
                    if visible.isEmpty {
                        Text(filter == .pinned ? "No pinned chats yet" : "No chats match")
                            .font(Type.inter(15, .body))
                            .foregroundStyle(Praxis.mutedInk)
                            .padding(.top, 12)
                    }
                }
                .padding(.horizontal, 24)
                .padding(.top, 18)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            bottomBar
        }
        .background(Praxis.canvas)
        .presentationDetents([.large])
        .presentationDragIndicator(.hidden)
    }

    private var header: some View {
        ZStack {
            Text("Chats")
                .font(Type.inter(17, weight: .semibold, .body))
                .foregroundStyle(Praxis.ink)
            HStack {
                Button { dismiss() } label: {
                    Image(systemName: "line.3.horizontal")
                        .font(.system(size: 14, weight: .medium))
                        .frame(width: 40, height: 40).contentShape(Circle())
                }
                .buttonStyle(PressScaleStyle())
                .praxisGlass(in: Circle())
                .accessibilityLabel("Close history")
                Spacer()
                if selecting {
                    Button("Done") {
                        selecting = false
                        selectedIDs = []
                    }
                    .font(Type.inter(15, weight: .semibold, .body))
                    .foregroundStyle(Praxis.ink)
                    .accessibilityLabel("Done selecting")
                } else {
                    Menu {
                        Button {
                            selecting = true
                        } label: { Label("Select chats", systemImage: "checkmark.circle") }
                        Divider()
                        Button {
                            filter = .all
                        } label: {
                            Label("All", systemImage: filter == .all ? "checkmark" : "bubble.left.and.bubble.right")
                        }
                        Button {
                            filter = .pinned
                        } label: { Label("Pinned", systemImage: "pin") }
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.system(size: 14, weight: .semibold))
                            .frame(width: 40, height: 40).contentShape(Circle())
                    }
                    .buttonStyle(PressScaleStyle())
                    .praxisGlass(in: Circle())
                    .accessibilityLabel("History options")
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
    }

    private func row(_ conv: Conversation) -> some View {
        Button {
            if selecting {
                if selectedIDs.contains(conv.id) { selectedIDs.remove(conv.id) }
                else { selectedIDs.insert(conv.id) }
            } else {
                withAnimation(Motion.morph) { store.select(conv.id) }
                dismiss()
            }
        } label: {
            HStack(alignment: .top, spacing: 14) {
                if selecting {
                    Image(systemName: selectedIDs.contains(conv.id) ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: 20))
                        .foregroundStyle(selectedIDs.contains(conv.id) ? Praxis.ink : Praxis.pressedMuted)
                }
                Image(systemName: "message")
                    .font(.system(size: 15))
                    .foregroundStyle(Praxis.secondaryInk)
                    .padding(.top, 3)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(conv.title)
                            .font(Type.inter(17, .body))
                            .foregroundStyle(Praxis.ink)
                            .lineLimit(1)
                        if conv.isPinned {
                            Image(systemName: "pin.fill")
                                .font(.system(size: 9))
                                .foregroundStyle(Praxis.mutedInk)
                        }
                    }
                    Text(conv.updatedAt.formatted(.relative(presentation: .named, unitsStyle: .wide)))
                        .font(Type.inter(14, .subheadline))
                        .foregroundStyle(Praxis.mutedInk)
                }
                Spacer(minLength: 0)
                if store.selectedID == conv.id && !selecting {
                    Image(systemName: "checkmark")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Praxis.mutedInk)
                        .padding(.top, 4)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleStyle(scale: 0.99))
        .contextMenu {
            Button {
                store.togglePinned(conv.id)
            } label: {
                Label(conv.isPinned ? "Unpin" : "Pin", systemImage: conv.isPinned ? "pin.slash" : "pin")
            }
        }
        .accessibilityLabel(conv.title)
    }

    private var bottomBar: some View {
        VStack(spacing: 12) {
            HStack {
                if selecting {
                    Button(role: .destructive) {
                        store.conversations.removeAll { selectedIDs.contains($0.id) }
                        if let first = store.conversations.first { store.select(first.id) }
                        selectedIDs = []
                        selecting = false
                    } label: {
                        Text("Delete")
                            .font(Type.inter(15, weight: .semibold, .body))
                            .foregroundStyle(Praxis.destructive)
                            .padding(.horizontal, 18)
                            .padding(.vertical, 11)
                    }
                    .buttonStyle(PressScaleStyle())
                    .praxisGlass(in: Capsule())
                    .disabled(selectedIDs.isEmpty)
                    .opacity(selectedIDs.isEmpty ? 0.45 : 1)
                    .accessibilityLabel("Delete selected chats")
                }
                Spacer()
                Button {
                    store.newChat()
                    dismiss()
                } label: {
                    HStack(spacing: 7) {
                        Image(systemName: "plus").font(.system(size: 13, weight: .semibold))
                        Text("New chat").font(Type.inter(15, weight: .semibold, .body))
                    }
                    .foregroundStyle(Praxis.canvas)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 11)
                }
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.capsule)
                .tint(Praxis.ink)
                .accessibilityLabel("New chat")
            }
            HStack(spacing: 9) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Praxis.ink)
                TextField("Search", text: $query)
                    .font(Type.inter(16, .body))
                    .foregroundStyle(Praxis.ink)
                    .accessibilityLabel("Search")
            }
            .padding(.horizontal, 16)
            .frame(height: 48)
            .praxisGlass(in: Capsule())
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 10)
    }
}

/// Thick-glass mock file sheet (§9.2 FileRef tap).
struct FilePreviewSheet: View {
    let name: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(MockData.mockFileContents(name: name))
                    .font(Type.mono(12, .caption))
                    .lineSpacing(6)
                    .foregroundStyle(Praxis.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(20)
            }
            .background(Praxis.canvas)
            .navigationTitle(name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.large])
    }
}

/// Glass link preview card (§9.2 LinkRef tap) → SFSafariViewController.
struct LinkPreviewSheet: View {
    let url: URL
    @Environment(\.dismiss) private var dismiss
    @State private var showSafari = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                IntegrationAvatar(monogram: String((url.host() ?? "L").prefix(1)).uppercased())
                VStack(alignment: .leading, spacing: 2) {
                    Text(pageTitle).font(Type.inter(16, weight: .semibold, .body)).foregroundStyle(Praxis.ink)
                    Text(url.host() ?? url.absoluteString)
                        .font(Type.mono(12, .caption)).foregroundStyle(Praxis.mutedInk)
                }
                Spacer()
                Button { dismiss() } label: {
                    Image(systemName: "xmark").font(.system(size: 11, weight: .bold))
                        .frame(width: 30, height: 30).contentShape(Circle())
                }
                .buttonStyle(PressScaleStyle())
                .praxisGlass(in: Circle())
                .accessibilityLabel("Close preview")
            }
            Text("Reference from the Praxis design system — materials, agent activity and inline chips, rendered as live previews.")
                .font(Type.inter(14, .subheadline))
                .lineSpacing(6)
                .foregroundStyle(Praxis.secondaryInk)
            Button {
                showSafari = true
            } label: {
                Text("Open")
                    .font(Type.inter(15, weight: .semibold, .body))
                    .foregroundStyle(Praxis.canvas)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
            }
            .buttonStyle(.glassProminent)
            .tint(Praxis.ink)
        }
        .padding(16)
        .presentationDetents([.height(218)])
        .presentationBackground(.clear)
        .fullScreenCover(isPresented: $showSafari) {
            SafariView(url: url).ignoresSafeArea()
        }
    }

    private var pageTitle: String {
        let host = url.host() ?? ""
        if host.contains("apple") { return "SwiftUI Documentation" }
        if host.contains("webaim") { return "Contrast Checker" }
        return "Praxis Design System"
    }
}

import SafariServices

struct SafariView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }
    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
