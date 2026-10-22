import Foundation
import XCTest

/// External UI driver. Catalog responses come from the running product and isolated source stores.
final class CatalogModeUITests: XCTestCase {
    @MainActor
    func testDesktopPreflight() throws {
        let app = try XCUIApplication(url: URL(fileURLWithPath: self.setting("OPENCLAW_PREFLIGHT_APP")))
        defer { app.terminate() }
        app.launch()
        let button = app.buttons["Confirm desktop"]
        XCTAssertTrue(button.waitForExistence(timeout: 10))
        button.click()
        XCTAssertTrue(app.staticTexts["Desktop interaction worked"].waitForExistence(timeout: 5))
        self.capture(app, name: "desktop-preflight")
    }

    private struct Fixture: Codable {
        let catalogId: String
        let title: String
        let sentinel: String
        let threadId: String
    }

    private struct Plan: Decodable {
        let stage: String
        let app: String
        let appEnvironment: [String: String]
        let remoteURL: String
        let remoteToken: String
        let localFixtures: [Fixture]
        let remoteFixtures: [Fixture]
    }

    private struct VisibleRead: Codable {
        let threadId: String
        let title: String
        let visibleOccurrences: Int
        let openedOccurrence: Int
        let transcriptVisible: Bool
    }

    @MainActor
    func testLocalRemoteLocalCatalogAccess() async throws {
        self.continueAfterFailure = false
        let networkMonitor = self.installLocalNetworkDenialMonitor(appDisplayName: "OpenClawCatalogProof")
        defer { self.removeUIInterruptionMonitor(networkMonitor) }
        let plan = try JSONDecoder().decode(Plan.self, from: Data(contentsOf: URL(
            fileURLWithPath: self.setting("OPENCLAW_CATALOG_PLAN"))))
        guard ["main", "candidate"].contains(plan.stage), !plan.localFixtures.isEmpty,
              !plan.remoteFixtures.isEmpty else { throw self.failure("Incomplete synthetic case plan") }
        let app = try XCUIApplication(url: URL(fileURLWithPath: plan.app))
        app.launchArguments = [
            "--attach-only", "-AppleInterfaceStyle", "Light",
            "-openclaw.nativeExperienceEnabled", "YES",
            "-openclaw.onboardingSeen", "YES", "-openclaw.onboardingVersion", "8",
            "-openclaw.debug.fileLogEnabled", "YES",
            "-NSQuitAlwaysKeepsWindows", "NO",
        ]
        app.launchEnvironment = plan.appEnvironment
        defer {
            self.capture(app, name: "final")
            app.terminate()
        }
        app.launch()
        try await self.openProofWindowFromStatusItem(app) {
            self.capture(app, name: "status-item-not-ready")
        }
        var flows: [[String: Any]] = []
        for phase in ["local-1", "remote", "local-2"] {
            if phase != "local-1" { try self.closeCurrentChatWindow(app) }
            if phase == "remote" {
                try await self.changeMode(app, remote: true, plan: plan)
            } else if phase == "local-2" {
                try await self.changeMode(app, remote: false, plan: plan)
            }
            try await self.openPrimaryChat(app)
            let observation = try await self.observe(phase, app: app)
            let fixtures = phase == "remote" ? plan.remoteFixtures : plan.localFixtures
            let visible = try await self.readVisibleConversations(app, fixtures: fixtures, phase: phase, observation: observation)
            flows.append([
                "phase": phase,
                "observation": observation,
                "visibleReads": try JSONSerialization.jsonObject(with: JSONEncoder().encode(visible)),
            ])
        }
        // A normal process restart exercises persisted identity and worker startup, not a private hook.
        app.terminate()
        app.launch()
        try await self.openProofWindowFromStatusItem(app) {
            self.capture(app, name: "status-item-not-ready-after-relaunch")
        }
        try await self.openPrimaryChat(app)
        let observation = try await self.observe("local-reopened", app: app)
        let visible = try await self.readVisibleConversations(
            app, fixtures: plan.localFixtures, phase: "local-reopened", observation: observation)
        flows.append([
            "phase": "local-reopened", "observation": observation,
            "visibleReads": try JSONSerialization.jsonObject(with: JSONEncoder().encode(visible)),
        ])
        _ = try await self.control("/restart-local", label: "gateway-restart", app: app)
        let restartedObservation = try await self.observe("local-gateway-restarted", app: app)
        let restartedReads = try await self.readVisibleConversations(
            app, fixtures: plan.localFixtures, phase: "local-gateway-restarted", observation: restartedObservation)
        flows.append([
            "phase": "local-gateway-restarted", "observation": restartedObservation,
            "visibleReads": try JSONSerialization.jsonObject(with: JSONEncoder().encode(restartedReads)),
        ])
        let result: [String: Any] = ["stage": plan.stage, "status": "observed", "flows": flows,
                                   "proofVerdict": "requires-before-after-review"]
        let attachment = XCTAttachment(data: try JSONSerialization.data(
            withJSONObject: result, options: [.prettyPrinted, .sortedKeys]), uniformTypeIdentifier: "public.json")
        attachment.name = "catalog-case-result"
        attachment.lifetime = .keepAlways
        self.add(attachment)
    }

    @MainActor
    private func closeCurrentChatWindow(_ app: XCUIApplication) throws {
        let window = app.windows.containing(.button, identifier: "chat-new-thread").firstMatch
        guard window.exists else { throw self.failure("The previous primary chat window is unavailable") }
        window.click()
        app.typeKey("w", modifierFlags: .command)
        guard window.waitForNonExistence(timeout: 10) else {
            self.capture(app, name: "previous-chat-window-did-not-close")
            throw self.failure("The previous chat window did not close before changing connection mode")
        }
    }

    @MainActor
    private func changeMode(_ app: XCUIApplication, remote: Bool, plan: Plan) async throws {
        try await self.openGatewayMenu(app)
        try await self.click(app.menuItems["Manage Gateways…"], app: app)
        try await self.click(app.buttons["Connection"], app: app)
        let previous = remote ? "Local (this Mac)" : "Remote (another host)"
        let pickers = app.popUpButtons.matching(NSPredicate(
            format: "label == %@ OR identifier == %@ OR value == %@",
            "Gateway location", "Gateway location", previous))
        try await self.requireVisible(pickers.firstMatch, app: app, message: "Gateway location picker is absent")
        guard pickers.count == 1 else {
            self.capture(app, name: "mode-picker-ambiguous")
            throw self.failure("Gateway location picker is absent or ambiguous")
        }
        try await self.click(pickers.element(boundBy: 0), app: app)
        try await self.click(app.menuItems[remote ? "Remote (another host)" : "Local (this Mac)"], app: app)
        if remote {
            let transport = app.popUpButtons.matching(NSPredicate(
                format: "label == %@ OR value == %@ OR value == %@",
                "Connection", "SSH tunnel", "Gateway address or setup code")).firstMatch
            try await self.click(transport, app: app)
            try await self.click(app.menuItems["Gateway address or setup code"], app: app)
            let address = app.textFields["Address or setup code"]
            try await self.replace(address, text: plan.remoteURL, app: app)
            try await self.replace(app.secureTextFields["Gateway token"], text: plan.remoteToken, app: app)
            try await self.click(app.buttons["Save connection"], app: app)
        }
        self.capture(app, name: remote ? "remote-selected" : "local-selected")
    }

    @MainActor
    private func readVisibleConversations(
        _ app: XCUIApplication, fixtures: [Fixture], phase: String, observation: [String: Any]) async throws -> [VisibleRead]
    {
        let raw = try XCTUnwrap(observation["observation"] as? [String: Any])
        guard raw["status"] as? String == "observation_collected" else {
            throw self.failure("Catalog RPC evidence is incomplete; row counts cannot prove access")
        }
        let occurrences = try XCTUnwrap(raw["occurrences"] as? [[String: Any]])
        // Scope row counts to the sidebar; the selected conversation title can also appear in its header.
        let windows = app.windows.containing(.button, identifier: "chat-new-thread")
        try await self.requireVisible(windows.firstMatch, app: app, message: "Native chat window is unavailable")
        guard windows.count == 1, fixtures.count > 1 else {
            throw self.failure("The observation needs one native chat window and distinct control conversations")
        }
        let window = windows.firstMatch
        let sidebar = window.outlines.containing(.button, identifier: "chat-new-thread").firstMatch
        try await self.requireVisible(sidebar, app: app, message: "Native catalog sidebar is unavailable")
        self.capture(app, name: "\(phase)-catalog-list")
        var reads: [VisibleRead] = []
        for (index, fixture) in fixtures.enumerated() {
            let rows = self.catalogRows(in: sidebar, title: fixture.title)
            try await self.reveal(rows.firstMatch, in: sidebar, app: app)
            let count = rows.count
            let expected = occurrences.filter {
                $0["catalogId"] as? String == fixture.catalogId && $0["threadId"] as? String == fixture.threadId
            }.count
            guard count == expected, count > 0 else {
                self.capture(app, name: "\(phase)-ui-rpc-count-mismatch")
                throw self.failure("The accessible UI does not expose every observed catalog occurrence")
            }
            for occurrence in 0..<count {
                // Move away first: an old transcript must not make a failed source click appear successful.
                let control = fixtures[(index + 1) % fixtures.count]
                guard control.sentinel != fixture.sentinel else { throw self.failure("Control text is not distinct") }
                let controlRow = self.catalogRows(in: sidebar, title: control.title).firstMatch
                try await self.reveal(controlRow, in: sidebar, app: app)
                try await self.openCatalogRow(controlRow, fixture: control, window: window, app: app)
                let stale = self.transcriptElement(window, sentinel: fixture.sentinel)
                guard !stale.exists || !stale.isHittable else { throw self.failure("Previous transcript is still visible") }
                guard rows.count == count else {
                    self.capture(app, name: "\(phase)-catalog-changed-during-read")
                    throw self.failure("Catalog rows changed during the UI observation")
                }
                let row = rows.element(boundBy: occurrence)
                try await self.reveal(row, in: sidebar, app: app)
                try await self.openCatalogRow(row, fixture: fixture, window: window, app: app)
                if fixtures.firstIndex(where: { $0.catalogId == fixture.catalogId }) == index {
                    self.capture(app, name: "\(phase)-conversation-\(index)-occurrence-\(occurrence)")
                }
                reads.append(.init(threadId: fixture.threadId, title: fixture.title,
                                   visibleOccurrences: count, openedOccurrence: occurrence, transcriptVisible: true))
            }
        }
        return reads
    }

    @MainActor
    private func reveal(_ element: XCUIElement, in sidebar: XCUIElement, app: XCUIApplication) async throws {
        if element.exists && element.isHittable { return }
        sidebar.scroll(byDeltaX: 0, deltaY: 6000)
        for _ in 0..<12 {
            if element.exists && element.isHittable { return }
            sidebar.scroll(byDeltaX: 0, deltaY: -300)
        }
        self.capture(app, name: "catalog-row-not-exposed")
        throw self.failure("Catalog row remained unavailable after bounded native scrolling")
    }

    @MainActor
    private func transcriptElement(_ window: XCUIElement, sentinel: String) -> XCUIElement {
        window.staticTexts.matching(NSPredicate(
            format: "label CONTAINS %@ OR value CONTAINS %@", sentinel, sentinel)).firstMatch
    }

    @MainActor
    private func openCatalogRow(
        _ row: XCUIElement, fixture: Fixture, window: XCUIElement, app: XCUIApplication) async throws
    {
        try await self.requireVisible(row, app: app, message: "Catalog occurrence is not visible")
        row.rightClick()
        try await self.click(app.menuItems["Open in OpenClaw"], app: app)
        try await self.requireVisible(self.transcriptElement(window, sentinel: fixture.sentinel),
                                      app: app, message: "Conversation content did not open")
    }

    @MainActor
    private func openGatewayMenu(_ app: XCUIApplication) async throws {
        app.activate()
        try await self.click(app.menuBars.menuBarItems["Gateways"], app: app)
    }

    @MainActor
    private func openPrimaryChat(_ app: XCUIApplication) async throws {
        try await self.openGatewayMenu(app)
        try await self.click(app.menuItems.matching(identifier: "primary").firstMatch, app: app)
    }

    @MainActor
    private func replace(_ element: XCUIElement, text: String, app: XCUIApplication) async throws {
        try await self.click(element, app: app)
        element.typeKey("a", modifierFlags: .command)
        element.typeText(text)
    }

    @MainActor
    private func click(_ element: XCUIElement, app: XCUIApplication) async throws {
        try await self.requireVisible(element, app: app, message: "Expected control is not hittable")
        element.click()
    }

    @MainActor
    private func requireVisible(_ element: XCUIElement, app: XCUIApplication, message: String) async throws {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == true AND hittable == true"), object: element)
        let result = await XCTWaiter.fulfillment(of: [expectation], timeout: 60)
        guard result == .completed else {
            self.capture(app, name: "failed-precondition")
            throw self.failure(message)
        }
    }

    @MainActor
    private func observe(_ phase: String, app: XCUIApplication) async throws -> [String: Any] {
        let initial = try await self.control("/snapshot/" + phase, label: phase, app: app)
        // The initial snapshot has already proved the real node and worker are ready.
        let windows = app.windows.containing(.button, identifier: "chat-new-thread")
        guard windows.count == 1 else { throw self.failure("Catalog refresh needs one native chat window") }
        let sidebars = windows.firstMatch.outlines.containing(.button, identifier: "chat-new-thread")
        guard sidebars.count == 1 else { throw self.failure("Catalog refresh needs one native sidebar") }
        let sidebar = sidebars.firstMatch
        guard let retry = try self.pendingCatalogRetry(in: sidebar) else { return initial }
        self.capture(app, name: "\(phase)-before-explicit-refresh")
        try await self.reveal(retry, in: sidebar, app: app)
        try await self.click(retry, app: app)
        let readinessDeadline = Date().addingTimeInterval(150)
        var refreshed = try await self.control("/after-ui-refresh/" + phase, label: "\(phase)-after-ui-refresh", app: app)
        let raw = try XCTUnwrap(refreshed["observation"] as? [String: Any])
        guard raw["status"] as? String == "observation_collected" else {
            try self.captureCatalogAttributes(sidebar, name: "\(phase)-incomplete-rpc-row-attributes")
            throw self.failure("Post-refresh catalog RPC evidence is incomplete")
        }
        let occurrences = try XCTUnwrap(raw["occurrences"] as? [[String: Any]])
        var expectedByTitle: [String: Int] = [:]
        for occurrence in occurrences {
            guard let title = occurrence["name"] as? String, !title.isEmpty else {
                throw self.failure("Observed catalog occurrence has no title for UI matching")
            }
            expectedByTitle[title, default: 0] += 1
        }
        guard !expectedByTitle.isEmpty else { throw self.failure("Observed catalog has no occurrences") }
        let expectations = expectedByTitle.map { title, count in
            XCTNSPredicateExpectation(predicate: NSPredicate(format: "count == %d", count),
                                      object: self.catalogRows(in: sidebar, title: title))
        }
        // Native refresh runs every 120s. Observe one cycle plus margin, without another click.
        // Cached rows can remain labelled catalog_pending even after they become readable.
        let settled = await XCTWaiter.fulfillment(of: expectations, timeout: max(0, readinessDeadline.timeIntervalSinceNow))
        self.capture(app, name: "\(phase)-after-explicit-refresh")
        try self.captureCatalogAttributes(sidebar, name: "\(phase)-row-attributes")
        guard settled == .completed else {
            throw self.failure("UI did not expose every observed catalog occurrence after one explicit refresh")
        }
        let pending = sidebar.staticTexts.matching(NSPredicate(
            format: "label CONTAINS %@ OR value CONTAINS %@", "[catalog_pending]", "[catalog_pending]"))
        refreshed["initialObservation"] = initial
        let action: [String: Any] = ["clicks": 1, "initialLoadSucceeded": false,
                                     "pendingIndicatorVisible": pending.count > 0]
        refreshed["explicitUIRefresh"] = action
        return refreshed
    }

    @MainActor
    private func catalogRows(in sidebar: XCUIElement, title: String) -> XCUIElementQuery {
        sidebar.staticTexts.matching(NSPredicate(format: "label == %@ OR value == %@", title, title))
    }

    @MainActor
    private func captureCatalogAttributes(_ sidebar: XCUIElement, name: String) throws {
        let rows = sidebar.staticTexts.allElementsBoundByIndex.map { element in
            ["identifier": element.identifier, "label": element.label, "value": element.value as? String ?? ""]
        }
        let attachment = XCTAttachment(data: try JSONEncoder().encode(rows), uniformTypeIdentifier: "public.json")
        attachment.name = name
        attachment.lifetime = .keepAlways
        self.add(attachment)
    }

    @MainActor
    private func pendingCatalogRetry(in sidebar: XCUIElement) throws -> XCUIElement? {
        let rows = sidebar.children(matching: .outlineRow).allElementsBoundByIndex
        let titles = ["Claude Code", "Codex"]
        var headings: [Int] = []
        for title in titles {
            let matches = rows.indices.filter { rows[$0].buttons[title].exists }
            guard matches.count == 1 else { throw self.failure("Catalog heading is missing or ambiguous: \(title)") }
            headings.append(matches[0])
        }
        // Both section buttons call the same scheduleRefresh owner; choose one pending section.
        for start in headings.sorted() {
            let end = headings.filter { $0 > start }.min() ?? rows.count
            let section = rows[(start + 1)..<end]
            let pending = section.contains { row in
                row.staticTexts.matching(NSPredicate(
                    format: "label CONTAINS %@ OR value CONTAINS %@", "[catalog_pending]", "[catalog_pending]")).count > 0
            }
            if !pending { continue }
            let buttons = section.flatMap { $0.buttons.matching(NSPredicate(format: "label == %@", "Retry")).allElementsBoundByIndex }
            guard buttons.count == 1 else { throw self.failure("Pending catalog Retry is missing or ambiguous") }
            return buttons[0]
        }
        return nil
    }

    @MainActor
    private func control(_ path: String, label: String, app: XCUIApplication) async throws -> [String: Any] {
        var request = URLRequest(url: try XCTUnwrap(URL(
            string: self.setting("OPENCLAW_CATALOG_CONTROL") + path)))
        request.httpMethod = "POST"
        // A failed snapshot can add two list and two read diagnostics (2 * (95s + 60s)).
        // Reserve that work plus 10s transport margin beyond the original 240s.
        let includesSnapshot = path.hasPrefix("/snapshot/") || path.hasPrefix("/after-ui-refresh/")
        let diagnosticBudget: TimeInterval = includesSnapshot ? 2 * (95 + 60) + 10 : 0
        request.timeoutInterval = 240 + diagnosticBudget
        let (data, response) = try await URLSession.shared.data(for: request)
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "\(label)-rpc-observation"
        attachment.lifetime = .keepAlways
        self.add(attachment)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            self.capture(app, name: "\(label)-observation-failed")
            throw self.failure("Real Gateway or native worker observation failed")
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @MainActor
    private func capture(_ app: XCUIApplication, name: String) {
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        self.add(screenshot)
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = "\(name)-accessibility-tree"
        tree.lifetime = .keepAlways
        self.add(tree)
    }

    private func setting(_ name: String) throws -> String {
        let env = ProcessInfo.processInfo.environment
        return try XCTUnwrap(env[name] ?? env["TEST_RUNNER_" + name])
    }

    private func failure(_ message: String) -> NSError {
        NSError(domain: "CatalogModeProof", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
