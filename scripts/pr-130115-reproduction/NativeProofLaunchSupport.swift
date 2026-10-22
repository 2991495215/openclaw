import Foundation
import XCTest

extension XCTestCase {
    @MainActor
    func installLocalNetworkDenialMonitor(appDisplayName: String) -> any NSObjectProtocol {
        self
            .addUIInterruptionMonitor(withDescription: "Deny only the proof app's local network prompt") { _ in
                let dialog = XCUIApplication(bundleIdentifier: "com.apple.UserNotificationCenter").dialogs["alert"]
                let expected = "Allow “\(appDisplayName)” to find devices on local networks?"
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
    }
}
