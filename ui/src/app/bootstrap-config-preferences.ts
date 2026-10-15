import { i18n, isSupportedLocale } from "../i18n/index.ts";
import { createRuntimeConfigCapability } from "../lib/config/runtime-config-capability.ts";
import type { ApplicationConfigCapability } from "./config.ts";
import type { ApplicationGateway } from "./gateway.ts";
import {
  rememberProfileAppearanceIdentity,
  seedProfileAppearancePrefs,
} from "./server-prefs-profile.ts";
import { applyServerUiPrefs } from "./server-prefs-reconcile.ts";
import { extractProfileUiPrefs, PROFILE_UI_PREFERENCE_KEYS } from "./server-prefs-state.ts";
import type { UiSettings } from "./settings.ts";
import { seedUserPreferences } from "./user-prefs-cache.ts";

/** Seed the document's admitted preferences, then bind them to the first connection. */
export function subscribeDocumentPreferences(
  gateway: ApplicationGateway,
  config: ApplicationConfigCapability,
  settings: UiSettings,
  canUseDocumentPreferences: () => boolean,
): () => void {
  const documentPreferences = canUseDocumentPreferences() ? config.preferences : undefined;
  if (documentPreferences) {
    const scope = gateway.connection.gatewayUrl;
    const { profileId, entries } = documentPreferences;
    rememberProfileAppearanceIdentity(scope, profileId ?? null);
    if (profileId && entries) {
      seedProfileAppearancePrefs(scope, profileId, extractProfileUiPrefs(entries));
    }
    applyServerUiPrefs(documentPreferences.config ?? {}, {
      scope,
      profileId,
      navigationConfirmed: entries !== undefined,
      onApplied: (patch) => Object.assign(settings, patch),
    });
    if (isSupportedLocale(settings.locale)) {
      void i18n.setLocale(settings.locale);
    }
  }
  let firstPreferencesConnection = true;
  return gateway.subscribe((snapshot) => {
    if (snapshot.phase !== "connected" || !snapshot.client || !firstPreferencesConnection) {
      return;
    }
    firstPreferencesConnection = false;
    const { profileId, entries } = documentPreferences ?? {};
    if (
      canUseDocumentPreferences() &&
      profileId === snapshot.selfUser?.id &&
      profileId &&
      entries
    ) {
      seedUserPreferences(snapshot.client, profileId, PROFILE_UI_PREFERENCE_KEYS, entries);
    }
  });
}

/** Runtime display reads share the authenticated document bootstrap, not an editor fetch. */
export function createBootstrapRuntimeConfig(
  gateway: ApplicationGateway,
  config: ApplicationConfigCapability,
  canUseDocumentPreferences: () => boolean,
) {
  return createRuntimeConfigCapability(gateway, {
    current: () => {
      const preferences = config.preferences;
      return canUseDocumentPreferences() &&
        (gateway.snapshot.phase !== "connected" ||
          preferences?.profileId === gateway.snapshot.selfUser?.id)
        ? (preferences?.config ?? null)
        : null;
    },
    ready: () =>
      Promise.all([
        config.refresh({ ifNeeded: true }),
        gateway.snapshot.selfUser === undefined ? gateway.loadSelfProfile() : Promise.resolve(),
      ]),
    subscribe: config.subscribe,
  });
}
