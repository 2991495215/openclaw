import { createMemo, createStore, onSettled } from "solid-js";
import type { ControlUiLinkPreview } from "../../../../../src/gateway/control-ui-contract.js";
import { resolveControlUiAuthToken } from "../../../app/control-ui-auth.ts";
import { postNativeExternalLink } from "../../../app/native-link-routing.ts";
import { isBrowserPanelAvailable } from "../../../app/panel-availability.ts";
import { browserTabKey, readBrowserTabTarget } from "../../../components/browser/browser-target.ts";
import { BROWSER_PANEL_TOGGLE_EVENT } from "../../../components/panel-toggle-contract.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import type { MenuItem } from "../../../components/solid/menu.tsx";
import { loadBrowserTabThumbnail } from "../../../lib/chat/browser-tab-preview.ts";
import { copyToClipboard } from "../../../lib/clipboard.ts";
import { canCallGatewayMethod } from "../../../lib/gateway-methods.ts";
import { loadLinkPreview } from "../../../lib/link-preview.ts";
import { openExternalUrlSafe, resolveSafeExternalUrl } from "../../../lib/open-external-url.ts";
import { useOptionalApplication } from "../../../lib/reactive/context.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import { BrowserTabCardView, browserTabCardData } from "./browser-tab-card-view.tsx";
import type { BrowserTabCardProps } from "./browser-tab-card.tsx";

export function BrowserTabCardRuntime(
  props: BrowserTabCardProps & {
    host: () => HTMLElement;
    menuId: string;
  },
) {
  const application = useOptionalApplication();
  const sources = createMemo(() => {
    const context = props.context ?? application;
    return (
      context && [
        projectOwner(context.gateway, (owner) => owner),
        projectOwner(context.config, (owner) => owner),
        projectOwner(context.theme, (owner) => owner),
      ]
    );
  });
  const context = () => {
    sources()?.forEach((source) => source.read());
    return props.context ?? application;
  };
  let active = true;
  const pageTarget = createMemo(
    () => {
      const current = context();
      const snapshot = current?.gateway.snapshot;
      const url = props.preview?.url;
      return current?.config.current.automaticallyFetchFavicons &&
        snapshot?.client &&
        url &&
        canCallGatewayMethod(snapshot, "controlUi.linkPreview", "operator.read", {
          requireAdvertisement: false,
        })
        ? { client: snapshot.client, url }
        : undefined;
    },
    {
      equals: (before, after) => before?.client === after?.client && before?.url === after?.url,
    },
  );
  const pagePreview = createMemo(() => {
    const target = pageTarget();
    // Each identity starts empty; loading never suspends the card's controls.
    return (
      target &&
      createMemo<ControlUiLinkPreview | undefined>(
        () => loadLinkPreview(target.client, target.url),
        { loadingValue: undefined },
      )
    );
  });
  // Screenshot refreshes and unavailable targets retain failures; a new target retries them.
  const [failedImages, setFailedImages] = createStore<Record<string, boolean>>((draft) => {
    if (pageTarget()) {
      for (const url of Object.keys(draft)) {
        delete draft[url];
      }
    }
  }, {});
  const thumbnailTarget = createMemo(
    () => {
      const current = context();
      const preview = props.preview;
      const revision = props.revision;
      const snapshot = current?.gateway.snapshot;
      const client = snapshot?.client;
      if (
        !preview ||
        !current ||
        !snapshot ||
        !client ||
        !isBrowserPanelAvailable(snapshot) ||
        !props.latest ||
        !revision
      ) {
        return undefined;
      }
      return {
        client,
        key: JSON.stringify([browserTabKey(preview), revision]),
        tab: preview,
        revision,
        context: current,
      };
    },
    { equals: (before, after) => before?.client === after?.client && before?.key === after?.key },
  );
  const thumbnail = createMemo(() => {
    const target = thumbnailTarget();
    return (
      target &&
      createMemo<string | undefined>(
        () =>
          loadBrowserTabThumbnail({
            client: target.client,
            tab: target.tab,
            revision: target.revision,
            resourceBasePath: target.context.resourceBasePath,
            authToken: resolveControlUiAuthToken({
              hello: target.context.gateway.snapshot.hello,
              settings: { token: target.context.gateway.connection.token },
              password: target.context.gateway.connection.password,
            }),
          }),
        { loadingValue: undefined },
      )
    );
  });
  onSettled(() => () => {
    active = false;
  });
  const opensExternally = () => context()?.theme.settings.openLinksExternally === true;
  const openExternal = () => {
    const url = resolveSafeExternalUrl(props.preview?.url ?? "", window.location.href);
    if (url && !postNativeExternalLink(url)) {
      openExternalUrlSafe(url);
    }
  };
  const openPanel = () => {
    const browserTab = readBrowserTabTarget(props.preview);
    if (browserTab) {
      props.host().dispatchEvent(
        new CustomEvent(BROWSER_PANEL_TOGGLE_EVENT, {
          detail: { open: true, browserTab },
          bubbles: true,
          composed: true,
        }),
      );
    }
  };
  const open = () => (opensExternally() ? openExternal() : openPanel());
  const onMenuSelect = (value: string) => {
    const url = props.preview?.url;
    if (!url) {
      return;
    }
    if (value === "copy-url") {
      void copyToClipboard(url, () => active && props.preview?.url === url);
    } else if (value === "open-new-tab") {
      openExternal();
    } else if (value === "open-within-openclaw") {
      openPanel();
    }
  };
  const menuItems = createMemo<MenuItem[]>(() => [
    {
      id: "copy-url",
      label: t("browser.copyUrl"),
      class: "session-menu__item",
      icon: (
        <span class="session-menu__icon" aria-hidden="true">
          <Icon name="copy" />
        </span>
      ),
    },
    {
      id: opensExternally() ? "open-within-openclaw" : "open-new-tab",
      label: opensExternally() ? t("browser.openWithinOpenClaw") : t("browser.openNewTab"),
      class: "session-menu__item",
      attributes: {
        "data-new-tab-action": !opensExternally() ? "" : undefined,
      },
      icon: (
        <span class="session-menu__icon" aria-hidden="true">
          <Icon name={opensExternally() ? "globe" : "externalLink"} />
        </span>
      ),
    },
  ]);
  const data = createMemo(() =>
    browserTabCardData(props.preview, thumbnail()?.(), pagePreview()?.(), failedImages),
  );
  return (
    <BrowserTabCardView
      data={data()}
      menuId={props.menuId}
      opensExternally={opensExternally()}
      failedImages={failedImages}
      menuItems={menuItems()}
      onOpen={open}
      onMenuSelect={onMenuSelect}
      onImageError={(src) =>
        setFailedImages((images) => {
          images[src] = true;
        })
      }
    />
  );
}
