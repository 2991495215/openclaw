import AppKit

@MainActor
final class DesktopPreflightDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private let label = NSTextField(labelWithString: "Desktop interaction pending")

    func applicationDidFinishLaunching(_: Notification) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 400, height: 160),
            styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Disposable desktop preflight"
        self.label.frame = NSRect(x: 24, y: 94, width: 350, height: 24)
        window.contentView?.addSubview(self.label)
        let button = NSButton(title: "Confirm desktop", target: self, action: #selector(self.confirm))
        button.frame = NSRect(x: 24, y: 30, width: 180, height: 32)
        window.contentView?.addSubview(button)
        self.window = window
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    @objc private func confirm() {
        self.label.stringValue = "Desktop interaction worked"
    }
}

@main
struct DesktopPreflightApp {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = DesktopPreflightDelegate()
        app.setActivationPolicy(.regular)
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
