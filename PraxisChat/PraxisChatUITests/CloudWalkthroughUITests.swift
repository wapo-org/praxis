import XCTest

/// Reads the user events channel exactly as the web client subscribes to it.
private final class UserEventsProbe: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var buffer = ""
    private var session: URLSession!
    init(after cursor: Int, token: String = "dev-local") {
        super.init()
        session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8807/v1/events")!)
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue(String(cursor), forHTTPHeaderField: "Last-Event-ID")
        request.timeoutInterval = 300
        session.dataTask(with: request).resume()
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock(); buffer += String(decoding: data, as: UTF8.self); lock.unlock()
    }
    /// Decoded `user.event` payloads received so far.
    var events: [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        return buffer.split(separator: "\n").compactMap { line in
            guard line.hasPrefix("data: ") else { return nil }
            return try? JSONSerialization.jsonObject(with: Data(line.dropFirst(6).utf8)) as? [String: Any]
        }
    }
    func waitForRun(_ matches: (String) -> Bool, timeout: TimeInterval = 20) -> String? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let id = events.last(where: { $0["entity"] as? String == "run" && matches($0["entityId"] as? String ?? "") })?["entityId"] as? String { return id }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return nil
    }
    func stop() { session.invalidateAndCancel() }
}

/// Opt-in real-server walkthrough. No URLProtocol, fabricated account or
/// connector OAuth completion is used by these screenshots.
final class CloudWalkthroughUITests: XCTestCase {
    private var app: XCUIApplication!
    private var style = "light"
    override func setUpWithError() throws {
        continueAfterFailure = false
        try XCTSkipUnless(ProcessInfo.processInfo.environment["PRAXIS_LIVE_API"] == "http://127.0.0.1:8807",
                          "Live walkthrough requires the worker's dev:local server on port 8807")
        style = ProcessInfo.processInfo.environment["PRAXIS_WALKTHROUGH_STYLE"] ?? "light"
        app = XCUIApplication()
    }
    override func tearDownWithError() throws { app?.terminate() }
    private func launch(_ script: String = "text") {
        app.terminate()
        app.launchArguments = ["-PraxisResetData", "YES", "-PraxisCloudServerURL", "http://127.0.0.1:8807", "-PraxisCloudScenario", script]
        app.launch()
        XCTAssertTrue(app.buttons["History"].waitForExistence(timeout: 20))
    }
    private func tap(_ element: XCUIElement) {
        XCTAssertTrue(element.waitForExistence(timeout: 15))
        for _ in 0..<5 { if element.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(element.isHittable)
        element.tap()
    }
    private func settings() {
        tap(app.buttons["History"]); tap(app.buttons["History options"]); tap(app.buttons["Settings"])
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
    }
    private func shot(_ screen: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "\(screen)-\(style)"; attachment.lifetime = .keepAlways; add(attachment)
    }
    private func send(_ script: String) {
        launch(script)
        tap(app.buttons["New chat"])
        let field = app.textViews["Message"].exists ? app.textViews["Message"] : app.textFields["Message"]
        tap(field); field.typeText("Walkthrough \(script)")
        tap(app.buttons["Send message"])
    }
    /// Same API the web client uses, authenticated as the app's local dev user.
    @discardableResult
    private func api(_ method: String, _ path: String, _ body: [String: Any]? = nil, token: String = "dev-local") -> (Int, [String: Any]) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8807" + path)!)
        request.httpMethod = method
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        let done = DispatchSemaphore(value: 0)
        nonisolated(unsafe) var result: (Int, [String: Any]) = (0, [:])
        URLSession.shared.dataTask(with: request) { data, response, _ in
            result = ((response as? HTTPURLResponse)?.statusCode ?? 0,
                      data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:])
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 20)
        return result
    }
    /// Fresh local session: dev deletion confirms sessions younger than five minutes.
    private func signInLocally() {
        launch(); settings(); tap(app.buttons["cloudAccountServer"])
        if app.buttons["cloudSignOut"].waitForExistence(timeout: 3) { tap(app.buttons["cloudSignOut"]) }
        tap(app.buttons["cloudLocalSignIn"])
        XCTAssertTrue(app.buttons["cloudSignOut"].waitForExistence(timeout: 15))
    }
    /// Part of the ordered walkthrough (deletion must come after it).
    private func followWebStartedRunLive() {
        signInLocally()
        launch()
        let token = "C5 web \(UUID().uuidString.prefix(6))"
        let (chatStatus, chat) = api("POST", "/v1/chats", ["type": "chat.input", "title": token])
        XCTAssertEqual(chatStatus, 201, "\(chat)")
        let chatID = try! XCTUnwrap(chat["id"] as? String)
        let (runStatus, run) = api("POST", "/v1/runs", ["type": "run.start", "chatId": chatID, "text": token,
                                                         "script": "approval", "idempotencyKey": UUID().uuidString])
        XCTAssertTrue((200..<300).contains(runStatus), "\(run)")
        let runID = try! XCTUnwrap(run["id"] as? String)
        let probe = UserEventsProbe(after: eventCursor())
        // The app stays in the foreground: only the user events channel can surface this run.
        tap(app.buttons["History"])
        tap(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", token)).firstMatch)
        XCTAssertTrue(app.buttons["Allow once"].waitForExistence(timeout: 20), "A web-started approval must reach the phone live")
        shot("web-run-approval-on-phone")
        tap(app.buttons["Allow once"])
        var status = ""
        for _ in 0..<40 where status != "completed" {
            status = api("GET", "/v1/runs/" + runID).1["status"] as? String ?? ""
            if status != "completed" { Thread.sleep(forTimeInterval: 0.5) }
        }
        XCTAssertEqual(status, "completed")
        XCTAssertNotNil(probe.waitForRun { $0 == runID }, "The web's user events channel reports the run approved on iOS")
        probe.stop()
        let messages = api("GET", "/v1/chats/" + chatID + "/messages").1["items"] as? [[String: Any]] ?? []
        // Tool results are user-role rows; a re-sent prompt would show up as a second run.
        XCTAssertEqual(Set(messages.compactMap { $0["runId"] as? String }), [runID], "The phone must not re-send the web prompt")
    }
    private func eventCursor() -> Int { api("GET", "/v1/bootstrap").1["eventCursor"] as? Int ?? 0 }
    /// Reverse direction: a run started on the phone appears on the web's channel
    /// with the same answer the phone shows.
    private func watchPhoneRunOnWebLive() {
        let probe = UserEventsProbe(after: eventCursor())
        defer { probe.stop() }
        send("text")
        XCTAssertTrue(app.buttons["Stop generating"].waitForNonExistence(timeout: 20))
        let runID = try! XCTUnwrap(probe.waitForRun { _ in true }, "The web's user events channel announces the phone's run")
        var snapshot: [String: Any] = [:]
        for _ in 0..<40 {
            snapshot = api("GET", "/v1/runs/" + runID + "/snapshot").1
            if (snapshot["run"] as? [String: Any])?["status"] as? String == "completed" { break }
            Thread.sleep(forTimeInterval: 0.5)
        }
        XCTAssertEqual((snapshot["run"] as? [String: Any])?["status"] as? String, "completed")
        let answer = (snapshot["blocks"] as? [[String: Any]] ?? []).filter { $0["type"] as? String == "text" }
            .compactMap { $0["text"] as? String }.joined()
        XCTAssertFalse(answer.isEmpty, "The web reads the phone's answer from the run snapshot")
        let prefix = String(answer.prefix(24))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", prefix)).firstMatch.waitForExistence(timeout: 10),
                      "Phone and web show the same answer: \(prefix)")
        shot("phone-run-seen-on-web-channel")
    }
    /// Deletion runs last: dev:local answers 500 to the same dev user afterwards.
    private func deleteAccountLive() {
        signInLocally()
        tap(app.buttons["cloudDeleteAccount"])
        tap(app.buttons["cloudConfirmDeleteAccount"])
        XCTAssertTrue(app.staticTexts["cloudAccountDeleted"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.textFields["cloudEmail"].waitForExistence(timeout: 10))
        shot("account-deleted")
        XCTAssertNotEqual(api("GET", "/v1/chats").0, 200, "The deleted account's session is revoked")
    }
    func testLiveWalkthrough() {
        launch(); settings(); tap(app.buttons["cloudAccountServer"])
        if app.buttons["cloudSignOut"].waitForExistence(timeout: 3) { tap(app.buttons["cloudSignOut"]) }
        XCTAssertTrue(app.textFields["cloudEmail"].waitForExistence(timeout: 10))
        shot("sign-in")
        tap(app.buttons["cloudLocalSignIn"])
        XCTAssertTrue(app.buttons["cloudSignOut"].waitForExistence(timeout: 15))
        app.swipeDown()
        shot("account-signed-in")
        // Relaunch uses the real origin-scoped Keychain session.
        launch(); tap(app.buttons["New chat"]); shot("empty-chat")
        tap(app.buttons["Add photos, files and more"])
        tap(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Model, '")).firstMatch)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Select '")).firstMatch.waitForExistence(timeout: 15))
        shot("model-picker")
        launch(); tap(app.buttons["History"]); shot("history")
        launch(); settings(); shot("settings")
        tap(app.buttons["Connectors"]); XCTAssertTrue(app.navigationBars["Connectors"].waitForExistence(timeout: 10)); shot("connectors")
        tap(app.navigationBars.buttons["Settings"])
        tap(app.buttons["Skills"]); XCTAssertTrue(app.navigationBars["Skills"].waitForExistence(timeout: 10)); shot("skills")
        send("approval")
        XCTAssertTrue(app.buttons["Allow once"].waitForExistence(timeout: 20))
        shot("streaming-with-tool-rows"); shot("approval")
        tap(app.buttons["Allow once"])
        XCTAssertTrue(app.buttons["Stop generating"].waitForNonExistence(timeout: 15))
        send("elicitation")
        XCTAssertTrue(app.navigationBars["Connector request"].waitForExistence(timeout: 20)); shot("elicitation-form")
        tap(app.buttons["Cancel request"])
        send("elicitationURL")
        XCTAssertTrue(app.staticTexts["Sign in to Local Connector to continue."].waitForExistence(timeout: 20))
        shot("elicitation-url"); tap(app.buttons["Cancel request"])
        followWebStartedRunLive()
        watchPhoneRunOnWebLive()
        deleteAccountLive()
    }
}
