import SwiftUI

@main
struct PraxisChatApp: App {
    @State private var store = ChatStore()

    var body: some Scene {
        WindowGroup {
            ChatScreen()
                .praxisHaptics()
                .environment(store)
                .environment(store.haptics)
        }
    }
}
