export type WebKitHostMessages = {
  openclawLink: { type: "open-link"; url: string; target: "external" };
  openclawUpdate: { type: "start-update" };
  openclawNav: { type: "nav-state"; collapsed: boolean; width: number };
  openclawWindowDrag: { type: "window-drag" };
  openclawGateways:
    | {
        type: "select" | "open-window" | "set-primary" | "reconnect" | "reconnect-cancel";
        id: string;
      }
    | { type: "open-settings" };
  openclawNotifications:
    | { type: "status" | "request-permission" | "send-test" }
    | {
        type: "background-session-completed";
        runId: string;
        path: string;
        search?: string;
      };
};

type WebKitHostWindow = Window & {
  webkit?: {
    messageHandlers?: {
      [Name in keyof WebKitHostMessages]?: {
        postMessage(message: WebKitHostMessages[Name]): void;
      };
    };
  };
};

export function webKitHostWindow(): WebKitHostWindow | undefined {
  // SAFETY: WebKit owns this optional ambient bridge and the mapped contract narrows every handler.
  return typeof window === "undefined" ? undefined : (window as WebKitHostWindow);
}
