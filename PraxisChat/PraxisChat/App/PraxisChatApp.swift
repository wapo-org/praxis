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
                // The real Recordings destination for Settings → Voice
                // input (voice-groq's screen reads this slot; default is
                // their empty state when there's no controller).
                .environment(\.voiceRecordingsList, store.voice.map {
                    AnyView(VoiceRecordingsListView(voice: $0))
                } ?? AnyView(VoiceRecordingsEmptyView()))
                // Background runs (BACKGROUND_PLAN.md §2.2): entering the
                // background asks notification permission the first time
                // a run is in flight and opens fallback grace where the
                // continued task is missing; returning reconciles. Both
                // are no-ops when nothing runs.
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
