import Foundation
import XCTest

/// External GUI proof, adapted from scripts/mac-narration-proof at e0a75bdc3dd7.
/// No app test factories or direct lifecycle calls participate in these actions.
final class SavedGatewayOpeningUITests: XCTestCase {
    @MainActor
    func testDesktopPreflight() throws {
        let app = try XCUIApplication(url: URL(fileURLWithPath: self.setting("OPENCLAW_PROOF_APP")))
        defer { app.terminate() }
        app.launch()
        let button = app.buttons["Confirm desktop"]
        XCTAssertTrue(button.waitForExistence(timeout: 10))
        button.click()
        XCTAssertTrue(app.staticTexts["Desktop interaction worked"].waitForExistence(timeout: 5))
        self.capture(app, name: "desktop-preflight")
    }

    @MainActor
    func testSavedGatewayOpening() async throws {
        self.continueAfterFailure = false
        let networkMonitor = self
            .addUIInterruptionMonitor(withDescription: "Deny only the proof app's local network prompt") { _ in
                let dialog = XCUIApplication(bundleIdentifier: "com.apple.UserNotificationCenter").dialogs["alert"]
                let expected = "Allow “OpenClawSavedGatewayProof” to find devices on local networks?"
                guard dialog.exists, dialog.staticTexts.allElementsBoundByIndex.contains(where: { text in
                    [text.label, text.value as? String ?? ""].contains { value in
                        value.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression) == expected
                    }
                }) else { return false }
                XCTContext.runActivity(named: "Inspect the exact local network prompt") { activity in
                    let tree = XCTAttachment(string: dialog.debugDescription)
                    tree.name = "local-network-alert-accessibility-tree"
                    tree.lifetime = .keepAlways
                    activity.add(tree)
                }
                let denyTitles = ["Don’t Allow", "Don't Allow"]
                let buttons = dialog.buttons.matching(NSPredicate(
                    format: "label IN %@ OR title IN %@ OR value IN %@", denyTitles, denyTitles, denyTitles))
                    .allElementsBoundByIndex
                guard buttons.count == 1, let deny = buttons.first, deny.isHittable else { return false }
                XCTContext
                    .runActivity(named: "Deny local network access for the synthetic loopback proof") { activity in
                        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
                        screenshot.name = "local-network-prompt"
                        screenshot.lifetime = .keepAlways
                        activity.add(screenshot)
                    }
                deny.click()
                guard dialog.waitForNonExistence(timeout: 5) else { return false }
                XCTContext.runActivity(named: "Local network permission denied") { activity in
                    let decision =
                        XCTAttachment(
                            string: "Clicked Don’t Allow on the exact proof-app local network prompt; dialog closed.")
                    decision.name = "local-network-decision"
                    decision.lifetime = .keepAlways
                    activity.add(decision)
                }
                return true
            }
        defer { self.removeUIInterruptionMonitor(networkMonitor) }
        let stage = try self.setting("OPENCLAW_PROOF_STAGE")
        let entry = try self.setting("OPENCLAW_PROOF_ENTRY")
        let native = try self.setting("OPENCLAW_PROOF_NATIVE") == "true"
        XCTAssertTrue(["main", "candidate"].contains(stage))
        XCTAssertTrue(["menu", "settings"].contains(entry))
        let app = try XCUIApplication(url: URL(fileURLWithPath: self.setting("OPENCLAW_PROOF_APP")))
        app.launchArguments = [
            "--attach-only", "-AppleInterfaceStyle", "Light",
            "-openclaw.webchat.lastGatewayProfileID", "",
            "-openclaw.webchat.lastGatewayLocal", "NO",
            "-openclaw.nativeExperienceEnabled", native ? "YES" : "NO",
            "-NSQuitAlwaysKeepsWindows", "NO",
        ]
        app.launchEnvironment = try [
            "HOME": self.setting("OPENCLAW_PROOF_HOME"),
            "CFFIXED_USER_HOME": self.setting("OPENCLAW_PROOF_HOME"),
            "OPENCLAW_STATE_DIR": self.setting("OPENCLAW_PROOF_STATE"),
            "OPENCLAW_CONFIG_PATH": self.setting("OPENCLAW_PROOF_CONFIG"),
            "OPENCLAW_PROFILE": "gatewayproof",
            "NSUnbufferedIO": "YES",
        ]
        defer {
            let tree = XCTAttachment(string: app.debugDescription)
            tree.name = "final-accessibility-tree"
            tree.lifetime = .keepAlways
            self.add(tree)
            app.terminate()
        }
        app.launch()
        try await self.openSavedSettings(app)
        let add = app.buttons["Add Gateway"]
        try self.require(add.waitForExistence(timeout: 10), app: app, message: "Add Gateway is absent")
        add.click()
        let name = app.textFields["Studio"]
        try self.require(name.waitForExistence(timeout: 5), app: app, message: "Gateway name field is absent")
        name.click()
        name.typeText("Reproduction server")
        let address = app.textFields["gateway.example.com"]
        address.click()
        address.typeText("ws://127.0.0.1:19878")
        let credentials = app.disclosureTriangles["Token or password"]
        try self.require(credentials.exists, app: app, message: "Credentials disclosure is absent")
        credentials.click()
        let token = app.secureTextFields.element(boundBy: 0)
        try self.require(token.waitForExistence(timeout: 5), app: app, message: "Token field is absent")
        token.click()
        token.typeText("synthetic-saved-gateway-token")
        app.buttons["Connect"].click()
        try self.require(
            app.staticTexts["Reproduction server"].waitForExistence(timeout: 10),
            app: app, message: "Saved profile did not commit")
        // Saving legitimately opens a window. Restart to obtain a cold fleet,
        // keeping only the profile that the real settings UI just persisted.
        app.terminate()
        app.launch()
        if entry == "settings" { try await self.openSavedSettings(app) }
        let initial = try await self.control("await-cold")
        XCTAssertEqual(initial["savedConnections"] as? Int, 0, "Saved Gateway was not cold; fixture is invalid")
        _ = try await self.control("arm", method: "POST")

        if entry == "settings" {
            let open = try self.savedOpenButton(app)
            open.click()
            _ = try await self.control("await-held")
            try await self.openGatewayMenu(app)
            app.typeKey(.escape, modifierFlags: [])
        } else {
            try await self.openGatewayMenu(app)
            let saved = app.menuItems["Reproduction server"]
            XCTAssertTrue(saved.waitForExistence(timeout: 5))
            saved.click()
            _ = try await self.control("await-held")
        }
        XCTAssertTrue(app.menuItems["Manage Gateways…"].waitForNonExistence(timeout: 5))
        self.capture(app, name: "\(stage)-\(entry)-pending")
        let observed = try await self.control("observe-cleanup")
        _ = try await self.control("release", method: "POST")
        let target = app.windows.matching(NSPredicate(format: "label CONTAINS %@", "Reproduction server")).firstMatch
        let ready = native
            ? target.textViews["chat-message-input"]
            : target.staticTexts["Synthetic Gateway ready"]
        let opened = await self.waitUntilVisible(ready, timeout: 20)
        self.capture(app, name: "\(stage)-\(entry)-settled")
        let openingFinished = try await self.control("state")
        var result: [String: Any] = [
            "stage": stage, "entry": entry, "native": native,
            "coldStartVerified": true, "heldRequestObserved": true,
            "closedWhileHeld": observed["closedWhileHeld"] as? Int ?? -1,
            "windowReady": opened,
            "bugReproduced": (observed["closedWhileHeld"] as? Int ?? 0) > 0 &&
                openingFinished["backendFailures"] as? Int == 0 && !opened,
            "network": observed,
            "openingFinished": openingFinished,
        ]
        if opened {
            _ = try await self.control("checkpoint", method: "POST")
            target.click()
            app.typeKey("m", modifierFlags: .command)
            try await self.openGatewayMenu(app)
            app.typeKey(.escape, modifierFlags: [])
            let minimized = try await self.control("observe-cleanup")
            let minimizedEvents = minimized["events"] as? [[String: Any]] ?? []
            let closedWhileMinimized = minimizedEvents.contains {
                $0["kind"] as? String == "socket-close" && $0["saved"] as? Bool == true
            }
            result["closedWhileMinimized"] = closedWhileMinimized
            self.capture(app, name: "\(stage)-\(entry)-minimized")

            try await self.openGatewayMenu(app)
            app.menuItems["Reproduction server"].click()
            let restored = await self.waitUntilVisible(ready, timeout: 15)
            result["restoredAfterMinimize"] = restored
            if restored {
                target.click()
                app.typeKey("w", modifierFlags: .command)
                result["windowClosed"] = target.waitForNonExistence(timeout: 5)
                try await self.openGatewayMenu(app)
                app.typeKey(.escape, modifierFlags: [])
                let closed = try await self.control("observe-cleanup")
                result["connectionsAfterClose"] = closed["savedConnections"]
                try await self.openGatewayMenu(app)
                app.menuItems["Reproduction server"].click()
                let reopened = await self.waitUntilVisible(ready, timeout: 15)
                result["reopened"] = reopened
                self.capture(app, name: "\(stage)-\(entry)-reopened")
                if reopened {
                    try await self.openSavedSettings(app)
                    let remove = app.buttons["Remove Reproduction server"]
                    XCTAssertTrue(remove.waitForExistence(timeout: 5))
                    remove.click()
                    let confirmation = app.buttons["Remove"]
                    XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
                    confirmation.click()
                    result["windowClosedAfterRemoval"] = target.waitForNonExistence(timeout: 10)
                    let removed = try await self.control("observe-cleanup")
                    result["connectionsAfterRemoval"] = removed["savedConnections"]
                    self.capture(app, name: "\(stage)-\(entry)-removed")
                }
            }
        }
        let finalState = try await self.control("state")
        result["finalState"] = finalState
        let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "case-result"
        attachment.lifetime = .keepAlways
        self.add(attachment)
        if stage == "candidate" {
            XCTAssertEqual(finalState["backendFailures"] as? Int, 0, "Synthetic backend failed")
            XCTAssertEqual(observed["closedWhileHeld"] as? Int, 0, "Menu cleanup closed the opening connection")
            XCTAssertTrue(opened, "Saved Gateway did not finish opening")
            XCTAssertEqual(result["closedWhileMinimized"] as? Bool, false)
            XCTAssertEqual(result["restoredAfterMinimize"] as? Bool, true)
            XCTAssertEqual(result["windowClosed"] as? Bool, true)
            XCTAssertEqual(result["connectionsAfterClose"] as? Int, 0)
            XCTAssertEqual(result["reopened"] as? Bool, true)
            XCTAssertEqual(result["windowClosedAfterRemoval"] as? Bool, true)
            XCTAssertEqual(result["connectionsAfterRemoval"] as? Int, 0)
        }
    }

    private func setting(_ key: String) throws -> String {
        try XCTUnwrap(ProcessInfo.processInfo.environment[key], "Missing proof input \(key)")
    }

    @MainActor
    private func savedOpenButton(_ app: XCUIApplication) throws -> XCUIElement {
        let name = app.staticTexts["Reproduction server"]
        let address = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "127.0.0.1:19878")).firstMatch
        XCTAssertTrue(name.waitForExistence(timeout: 5) && address.exists)
        // Legacy-primary migration can add a second saved row. Resolve the
        // visible row's button instead of relying on list order or a lone label.
        let top = min(name.frame.minY, address.frame.minY)
        let bottom = max(name.frame.maxY, address.frame.maxY)
        let buttons = app.buttons.matching(identifier: "Open Window").allElementsBoundByIndex.filter {
            $0.isHittable && $0.frame.maxY >= top && $0.frame.minY <= bottom
        }
        XCTAssertEqual(buttons.count, 1, "Expected one Open Window button in the synthetic server row")
        return try XCTUnwrap(buttons.first)
    }

    @MainActor
    private func openGatewayMenu(_ app: XCUIApplication) async throws {
        app.activate()
        let menu = app.menuBars.menuBarItems["Gateways"]
        let ready = await self.waitUntilVisible(menu, timeout: 10)
        self.captureDiagnostics(app, name: "before-gateways-menu")
        try self.require(ready, app: app, message: "Gateways menu is not hittable after app activation")
        menu.click()
    }

    @MainActor
    private func openSavedSettings(_ app: XCUIApplication) async throws {
        try await self.openGatewayMenu(app)
        let manage = app.menuItems["Manage Gateways…"]
        let ready = await self.waitUntilVisible(manage, timeout: 5)
        try self.require(ready, app: app, message: "Manage Gateways is not hittable")
        manage.click()
        try self.require(
            app.buttons["Add Gateway"].waitForExistence(timeout: 10),
            app: app, message: "Gateway settings did not open")
    }

    @MainActor
    private func require(_ condition: Bool, app: XCUIApplication, message: String) throws {
        guard condition else {
            self.captureDiagnostics(app, name: "failed-precondition")
            throw NSError(domain: "SavedGatewayProof", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
        }
    }

    @MainActor
    private func captureDiagnostics(_ app: XCUIApplication, name: String) {
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        self.add(screenshot)
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = "\(name)-accessibility-tree"
        tree.lifetime = .keepAlways
        self.add(tree)
    }

    @MainActor
    private func waitUntilVisible(_ element: XCUIElement, timeout: TimeInterval) async -> Bool {
        let condition = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == true AND hittable == true"), object: element)
        return await XCTWaiter.fulfillment(of: [condition], timeout: timeout) == .completed
    }

    @MainActor
    private func control(_ action: String, method: String = "GET") async throws -> [String: Any] {
        var request = try URLRequest(url: XCTUnwrap(URL(string: "http://127.0.0.1:19879/\(action)")))
        request.httpMethod = method
        request.timeoutInterval = 12
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @MainActor
    private func capture(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        self.add(attachment)
    }
}
