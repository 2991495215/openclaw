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
        let networkMonitor = self.installLocalNetworkDenialMonitor(appDisplayName: "OpenClawSavedGatewayProof")
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
        try await self.openPrimaryFromStatusItem(app)
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
        let credentialsFrame = credentials.frame
        try self.require(
            credentials.isHittable && abs(credentialsFrame.width - 147.5) <= 1 &&
                abs(credentialsFrame.height - 16) <= 1,
            app: app, message: "Credentials disclosure geometry differs from the captured control")
        // The captured AX frame starts at x244, while its disclosure glyph is at x270.
        // Clicking the frame center hits the label, which does not expand this Mac control.
        credentials.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5))
            .withOffset(CGVector(dx: 26, dy: 0)).click()
        let expansion = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "value == 1 OR value == '1'"), object: credentials)
        let expanded = await XCTWaiter.fulfillment(of: [expansion], timeout: 5) == .completed
        try self.require(expanded, app: app, message: "Credentials disclosure did not expand")
        let token = app.secureTextFields.element(boundBy: 0)
        let tokenReady = await self.waitUntilVisible(token, timeout: 5)
        try self.require(tokenReady, app: app, message: "Token field is not visible after expansion")
        token.click()
        token.typeText("synthetic-saved-gateway-token")
        app.buttons["Connect"].click()
        try self.require(
            app.windows["com_apple_SwiftUI_Settings_window"].staticTexts
                .matching(NSPredicate(format: "value == %@", "Reproduction server")).firstMatch
                .waitForExistence(timeout: 10),
            app: app, message: "Saved profile did not commit")
        // Saving legitimately opens a window. Restart to obtain a cold fleet,
        // keeping only the profile that the real settings UI just persisted.
        app.terminate()
        app.launch()
        try await self.openPrimaryFromStatusItem(app)
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
            let saved = app.menuBars.menuBarItems["Gateways"].menuItems["Reproduction server"]
            XCTAssertTrue(saved.waitForExistence(timeout: 5))
            saved.click()
            _ = try await self.control("await-held")
        }
        // AppKit retains closed menu items in its accessibility tree.
        let menuClosed = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "hittable == false"),
            object: app.menuBars.menuBarItems["Gateways"].menuItems["Manage Gateways…"])
        let closed = await XCTWaiter.fulfillment(of: [menuClosed], timeout: 5) == .completed
        try self.require(closed, app: app, message: "Gateways menu remains interactive")
        self.capture(app, name: "\(stage)-\(entry)-pending")
        let observed = try await self.control("observe-cleanup")
        _ = try await self.control("release", method: "POST")
        let savedWindows = app.windows.matching(NSPredicate(format: "title == %@", "Reproduction server"))
        let target = savedWindows.firstMatch
        let ready = native
            ? target.textViews["chat-message-input"]
            : target.staticTexts.matching(NSPredicate(format: "title == %@", "Saved Gateway ready")).firstMatch
        let opened = await self.waitUntilVisible(ready, timeout: 20)
        self.captureDiagnostics(app, name: "\(stage)-\(entry)-settled")
        if opened {
            try self.require(savedWindows.count == 1, app: app, message: "Saved window identity is ambiguous")
        }
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
            app.menuBars.menuBarItems["Gateways"].menuItems["Reproduction server"].click()
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
                app.menuBars.menuBarItems["Gateways"].menuItems["Reproduction server"].click()
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
        let settings = app.windows["com_apple_SwiftUI_Settings_window"]
        let names = settings.staticTexts.matching(NSPredicate(format: "value == %@", "Reproduction server"))
        let addresses = settings.staticTexts.matching(NSPredicate(format: "value == %@", "ws://127.0.0.1:19878"))
        let name = names.firstMatch
        let address = addresses.firstMatch
        try self.require(
            name.waitForExistence(timeout: 5) && names.count == 1 && addresses.count == 1,
            app: app, message: "Saved profile name or endpoint is absent or ambiguous")
        // Legacy-primary migration can add a second saved row. Resolve the
        // visible row's button instead of relying on list order or a lone label.
        let top = min(name.frame.minY, address.frame.minY)
        let bottom = max(name.frame.maxY, address.frame.maxY)
        let buttons = settings.buttons.matching(identifier: "Open Window").allElementsBoundByIndex.filter {
            $0.isHittable && $0.frame.maxY >= top && $0.frame.minY <= bottom
        }
        XCTAssertEqual(buttons.count, 1, "Expected one Open Window button in the synthetic server row")
        return try XCTUnwrap(buttons.first)
    }

    @MainActor
    private func openPrimaryFromStatusItem(_ app: XCUIApplication) async throws {
        let items = app.descendants(matching: .statusItem)
        let status = items.firstMatch
        let available = await self.waitUntilVisible(status, timeout: 10)
        try self.require(available && items.count == 1, app: app, message: "Unique status item is not ready")
        // This public click opens the dashboard after credential startup. The
        // launch arguments select primary; no state is cleared during the case.
        status.click()
        app.activate()
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
        let manage = app.menuBars.menuBarItems["Gateways"].menuItems["Manage Gateways…"]
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
