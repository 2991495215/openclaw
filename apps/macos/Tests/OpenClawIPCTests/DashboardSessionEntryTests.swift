import Foundation
import OpenClawKit
import Testing
import WebKit
@testable import OpenClaw

@Suite(.serialized, .testWaitLimit)
@MainActor
struct DashboardSessionEntryTests {
    @Test(arguments: ["restore", "fallback", "reload"])
    func `native chat documents use the private app entry`(_ operation: String) async throws {
        let chatPath = "/control/chat/main/topic"
        let chatRoute = chatPath + "?dashboard=expanded&draft=a+b%2Bc"
        var entries: [String] = []
        var publicReads = 0
        let server = try await DashboardHTTPFixture.start(requestHandler: { request in
            let target = request.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
            let components = URLComponents(string: target.replacingOccurrences(of: "+", with: "%20"))
            let entry = components?.path == "/control/__openclaw__/session-entry"
            if entry {
                entries.append(components?.queryItems?.first { $0.name == "path" }?.value ?? "")
            }
            let publicRead = components?.path.hasPrefix("/control/chat/") == true
            if publicRead { publicReads += 1 }
            let body = publicRead
                ? "<html><body>Conversation unavailable</body></html>"
                : """
                <html><body>Private application<script>
                \(entry ? "history.replaceState(null, '', '\(chatRoute)' + location.hash);" : "")
                </script></body></html>
                """
            return [
                "HTTP/1.1 \(publicRead ? "404 Not Found" : "200 OK")",
                "Content-Type: text/html; charset=utf-8",
                "Content-Length: \(body.utf8.count)",
                "Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'",
                "Connection: close", "", body,
            ].joined(separator: "\r\n")
        })
        defer { server.stop() }
        let baseURL = server.url("/control/")
        let chatURL = server.url(chatRoute + "#retained")
        let auth = DashboardWindowAuth.nativeDevice(
            gatewayUrl: server.websocketURL("/control/").absoluteString,
            token: "before",
            password: nil)
        let controller = DashboardWindowController(
            url: baseURL,
            auth: auth,
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        let manager = DashboardManager._testMake()
        manager._testSetController(controller)
        defer { manager.close() }
        controller.show(url: baseURL, auth: auth)
        try await DashboardTestWait.document(controller)

        var displayed = controller
        if operation == "fallback" {
            controller.dispatchNativeNavigation(.init(
                path: "/chat/main/topic",
                search: "?dashboard=expanded&draft=a+b%2Bc",
                fallbackURL: chatURL))
        } else {
            _ = try await controller.webView.evaluateJavaScript(
                "history.replaceState(null, '', '\(chatRoute)#retained')")
            if operation == "reload" {
                controller.reloadDashboard()
            } else {
                await manager.handleEndpointState(.ready(
                    mode: .local,
                    url: server.websocketURL("/control/"),
                    token: "after",
                    password: nil,
                    routeRevision: 0))
                displayed = try #require(manager._testController())
                #expect(displayed !== controller)
            }
        }
        try await DashboardTestWait.document(displayed) { displayed.webView.url?.path == chatPath }
        #expect(try await displayed.webView.evaluateJavaScript("document.body.firstChild.textContent") as? String ==
            "Private application")
        #expect(entries == [chatRoute])
        #expect(publicReads == 0)
        #expect(displayed.webView.url?.fragment == "retained")
    }
}
