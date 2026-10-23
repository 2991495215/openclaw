import type { ControlUiLinkPreview } from "../../../../../src/gateway/control-ui-contract.js";
import { BrandIcon, Icon } from "../../../components/solid/icon.tsx";
import { Menu, type MenuItem } from "../../../components/solid/menu.tsx";
import type { ToolPreview } from "../../../lib/chat/tool-cards.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import "../../../styles/session-menu.css";
import "./browser-tab-card.css";

/** Adapts existing anonymous page metadata; never fetches or embeds remote markup. */
function browserTabTweet(url: string, title?: string, page?: ControlUiLinkPreview) {
  const parsed = URL.parse(url);
  if (
    !parsed ||
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    !/^(?:(?:www|mobile)\.)?(?:x|twitter)\.com$/u.test(parsed.hostname)
  ) {
    return undefined;
  }
  const status = /^\/([a-zA-Z0-9_]{1,15})\/status\/\d+(?:\/(?:photo|video)\/\d+)?\/?$/u.exec(
    parsed.pathname,
  );
  const anonymous = /^\/i\/(?:web\/)?status\/\d+\/?$/u.test(parsed.pathname);
  if (!status && !anonymous) {
    return undefined;
  }
  let handle = anonymous ? undefined : status?.[1];
  let author: string | undefined;
  let text: string | undefined;
  for (const candidate of [page?.title, title]) {
    const clean = candidate?.trim().replace(/\s+\/\s+(?:X|Twitter)$/u, "");
    if (!clean) {
      continue;
    }
    const named =
      /^(.*?)\s+\(@([a-zA-Z0-9_]{1,15})\)(?:\s+on (?:X|Twitter))?(?::\s*([\s\S]+))?$/u.exec(clean);
    if (named && (!handle || named[2]!.toLowerCase() === handle.toLowerCase())) {
      author ??= named[1]?.trim() || undefined;
      handle ??= named[2];
      text ??= named[3];
    }
    const quoted = /^(.*?)\s+on (?:X|Twitter):\s*([\s\S]+)$/u.exec(clean);
    if (quoted && !named) {
      author ??= quoted[1]?.trim() || undefined;
      text ??= quoted[2];
    }
  }
  text = text?.trim();
  if (
    text &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("“") && text.endsWith("”")))
  ) {
    text = text.slice(1, -1);
  }
  return {
    author,
    handle: handle ? "@" + handle : undefined,
    text: page?.description?.trim() || text,
  };
}

export function browserTabCardData(
  preview: Extract<ToolPreview, { kind: "browser-tab" }> | undefined,
  currentImage?: string,
  page?: ControlUiLinkPreview,
  failedImages: Readonly<Record<string, boolean>> = {},
) {
  if (!preview) {
    return undefined;
  }
  const image = currentImage && !failedImages[currentImage] ? currentImage : page?.imageDataUrl;
  const pageHost = URL.parse(preview.url)?.host || preview.url;
  const title = preview.title?.trim() || page?.title || pageHost || t("browser.title");
  return {
    preview,
    currentImage,
    page,
    image,
    host: pageHost,
    title,
    label: preview.url ? `${title} — ${preview.url}` : title,
    tweet: browserTabTweet(preview.url, preview.title, page),
  };
}

export function BrowserTabCardView(props: {
  data: ReturnType<typeof browserTabCardData>;
  menuId: string;
  opensExternally?: boolean;
  failedImages?: Readonly<Record<string, boolean>>;
  menuItems?: readonly MenuItem[];
  pending?: boolean;
  onOpen?: () => void;
  onMenuSelect?: (value: string) => void;
  onImageError?: (src: string) => void;
}) {
  const renderImage = (src: string) => (
    <img src={src} alt="" onError={() => props.onImageError?.(src)} />
  );
  return (
    <>
      {props.data && (
        <div class={["card", { tweet: Boolean(props.data!.tweet) }]}>
          {props.data!.tweet && (
            <>
              <header class="tweet-header">
                <span class="tweet-mark" aria-hidden="true">
                  <BrandIcon name="x" />
                </span>
                <span class="identity">
                  <span class="tweet-author" dir="auto">
                    {props.data!.tweet!.author ?? t("browser.tweetPost")}
                  </span>
                  {props.data!.tweet!.handle && (
                    <span class="tweet-handle" dir="ltr">
                      {props.data!.tweet!.handle}
                    </span>
                  )}
                </span>
              </header>
              {props.data!.tweet!.text && (
                <p class="tweet-text" dir="auto">
                  {props.data!.tweet!.text}
                </p>
              )}
            </>
          )}
          {props.data!.image && !(props.failedImages ?? {})[props.data!.image!] && (
            <button
              type="button"
              class={["shot", { social: props.data!.image !== props.data!.currentImage }]}
              aria-label={props.data!.label}
              title={props.opensExternally ? t("browser.openExternal") : t("browser.openPanel")}
              data-new-tab-action={props.opensExternally ? "" : undefined}
              disabled={props.pending}
              onClick={() => props.onOpen?.()}
            >
              {renderImage(props.data!.image!)}
            </button>
          )}
          <div class="bar">
            {props.data!.tweet ? (
              <span class="tweet-source">{props.data!.host}</span>
            ) : (
              <>
                <span class="icon" aria-hidden="true">
                  {props.data!.page?.faviconDataUrl &&
                  !(props.failedImages ?? {})[props.data!.page!.faviconDataUrl!] ? (
                    renderImage(props.data!.page!.faviconDataUrl!)
                  ) : (
                    <Icon name="globe" />
                  )}
                </span>
                <span class="identity">
                  <span class="title">{props.data!.title}</span>
                  {props.data!.preview.url && <span class="url">{props.data!.preview.url}</span>}
                </span>
              </>
            )}
            <span class="actions">
              <button
                type="button"
                title={props.opensExternally ? t("browser.openExternal") : t("browser.openPanel")}
                data-new-tab-action={props.opensExternally ? "" : undefined}
                disabled={props.pending}
                onClick={() => props.onOpen?.()}
              >
                {t(props.data!.tweet ? "browser.openPost" : "browser.open")}
              </button>
              <Menu
                id={`browser-tab-card-${props.menuId}`}
                class="session-menu"
                placement="bottom-end"
                triggerClass="more"
                triggerAttributes={{ title: t("browser.moreActions") }}
                label={t("browser.moreActions")}
                trigger={<Icon name="moreHorizontal" />}
                disabled={props.pending}
                items={props.menuItems ?? []}
                onSelect={(item) => props.onMenuSelect?.(item.id)}
              />
            </span>
          </div>
        </div>
      )}
    </>
  );
}
