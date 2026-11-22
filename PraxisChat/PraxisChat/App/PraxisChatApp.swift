import SwiftUI

@main
struct PraxisChatApp: App {
    @State private var store = ChatStore.forLaunch()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ChatScreen()
                .praxisHaptics()
                .task { await store.prepareCloudSession() }
                .environment(store)
                .environment(store.haptics)
                // Injects production recordings list destination, overriding empty default.
                .environment(\.voiceRecordingsList, store.voice.map {
                    AnyView(VoiceRecordingsListView(voice: $0))
                } ?? AnyView(VoiceRecordingsEmptyView()))
                // Requests notification auth and starts grace on backgrounding; reconciles on foreground.
                .onChange(of: scenePhase) { _, phase in
                    switch phase {
                    case .background: store.appDidEnterBackground()
                    case .active: store.appDidBecomeActive()
                    case .inactive: break
                    @unknown default: break
                    }
                }
        }
    }
}
