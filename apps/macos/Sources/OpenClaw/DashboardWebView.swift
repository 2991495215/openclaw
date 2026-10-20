import AppKit
import WebKit

final class DashboardWebView: WKWebView {
    static let contentZoomDefaultsKey = "openclaw.contentZoom"
    var onContentZoomChanged: (() -> Void)?

    func changeContentZoom(by steps: Int) {
        self.setContentZoom((self.pageZoom * 10).rounded() / 10 + Double(steps) / 10)
    }

    func setContentZoom(_ zoom: Double) {
        self.pageZoom = Self.boundedContentZoom(zoom)
        AppDefaults.standard.set(Double(self.pageZoom), forKey: Self.contentZoomDefaultsKey)
        self.onContentZoomChanged?()
    }

    static func boundedContentZoom(_ zoom: Double) -> Double {
        zoom.isFinite && zoom > 0 ? min(2, max(0.5, zoom)) : 1
    }

    private static let hiddenContextMenuIdentifiers: Set<String> = [
        "WKMenuItemIdentifierReload",
        "WKMenuItemIdentifierOpenLinkInNewWindow",
        "WKMenuItemIdentifierOpenImageInNewWindow",
        "WKMenuItemIdentifierOpenMediaInNewWindow",
        "WKMenuItemIdentifierOpenFrameInNewWindow",
        "WKMenuItemIdentifierDownloadLinkedFile",
        "WKMenuItemIdentifierDownloadImage",
        "WKMenuItemIdentifierDownloadMedia",
    ]

    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        super.willOpenMenu(menu, with: event)
        let items = Self.filteredContextMenuItems(menu.items)
        menu.removeAllItems()
        for item in items {
            menu.addItem(item)
        }
    }

    static func filteredContextMenuItems(_ items: [NSMenuItem]) -> [NSMenuItem] {
        var filtered: [NSMenuItem] = []
        for item in items where !Self.hiddenContextMenuIdentifiers.contains(item.identifier?.rawValue ?? "") {
            if item.isSeparatorItem, filtered.last?.isSeparatorItem != false {
                continue
            }
            filtered.append(item)
        }
        if filtered.last?.isSeparatorItem == true {
            filtered.removeLast()
        }
        return filtered
    }
}
