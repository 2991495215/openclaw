import { t } from "../../lib/reactive/i18n.ts";
import { Icon } from "./icon.tsx";

export function PluginOfficialBadge() {
  return (
    <span
      class="plugin-official-badge"
      role="img"
      aria-label={t("pluginsPage.official")}
      title={t("pluginsPage.official")}
    >
      <Icon name="badgeCheck" />
    </span>
  );
}
