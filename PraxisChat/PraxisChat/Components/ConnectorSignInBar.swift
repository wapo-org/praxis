import SwiftUI

/// "Sign in to <server>" under an activity whose steps a connector
/// refused for missing credentials. Shown collapsed or expanded, one
/// button per server; it turns into "Signed in" once that works.
struct ConnectorSignInBar: View {
    let requests: [StepSignIn]
    @Environment(ChatStore.self) private var store: ChatStore?

    init(steps: [Step]) {
        var seen = Set<String>()
        requests = steps.compactMap(\.signIn).filter { seen.insert($0.serverID).inserted }
    }

    var body: some View {
        if !requests.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(requests, id: \.serverID) { request in
                    ConnectorSignInButton(request: request)
                }
            }
            .padding(.vertical, 4)
        }
    }
}

private struct ConnectorSignInButton: View {
    let request: StepSignIn
    @Environment(ChatStore.self) private var store: ChatStore?

    private enum Status { case needed, working, done, removed }

    private var status: Status {
        guard let library = store?.services?.connectors, library.server(request.serverID) != nil else { return .removed }
        if library.signingIn.contains(request.serverID) { return .working }
        if library.signedIn[request.serverID] == true, library.authRequirements[request.serverID] == nil { return .done }
        return .needed
    }

    var body: some View {
        switch status {
        case .removed:
            EmptyView()
        case .done:
            Label("Signed in to \(request.serverName) — ask again to retry", systemImage: "checkmark.circle")
                .font(Type.inter(13, .caption))
                .foregroundStyle(Praxis.mutedInk)
                .accessibilityIdentifier("connectorSignedIn")
        case .needed, .working:
            Button {
                store?.signInToConnector(request.serverID)
            } label: {
                PraxisButtonLabel(status == .working ? "Signing in to \(request.serverName)…" : "Sign in to \(request.serverName)",
                                  systemImage: "person.badge.key", working: status == .working)
            }
            .buttonStyle(.praxisSecondary(.compact))
            .disabled(status == .working)
            .accessibilityIdentifier("connectorSignIn")
            .accessibilityLabel("Sign in to \(request.serverName)")
        }
    }
}
