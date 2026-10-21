import { action, createMemo, createOptimistic, Errored, For, Loading, refresh } from "solid-js";
import { deviceSettingsGroupLabelKey } from "../../app-navigation.ts";
import type {
  NativeDeviceSettingsCapability,
  NativeDeviceSettingsSnapshot,
} from "../../app/native-device-settings.ts";
import {
  SettingsRow,
  SettingsSection,
  SettingsToggleRow,
} from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { SettingsSelectRow } from "./settings-select-row.tsx";

registerEnglishCatalog(registerSettingsEnglish);

type DeviceLocaleSelection = { primary: string; additional: string[] };
const pendingDeviceLocales = new WeakMap<
  NativeDeviceSettingsCapability,
  Partial<DeviceLocaleSelection>
>();

function deviceLocaleSelection(capability: NativeDeviceSettingsCapability) {
  const locale = capability.snapshot?.voice.locale;
  if (!locale) {
    return null;
  }
  const pending = pendingDeviceLocales.get(capability);
  const primary = pending?.primary ?? locale.primary;
  return {
    primary,
    available: locale.available,
    additional: [...new Set(pending?.additional ?? locale.additional)].filter(
      (id) => id !== primary,
    ),
  };
}

function changeDeviceLocales(
  capability: NativeDeviceSettingsCapability,
  change: Partial<DeviceLocaleSelection>,
) {
  const desired = Object.assign(pendingDeviceLocales.get(capability) ?? {}, change);
  pendingDeviceLocales.set(capability, desired);
  const writes: Promise<void>[] = [];
  for (const key of ["additional", "primary"] as const) {
    const value = change[key];
    if (value === undefined) {
      continue;
    }
    writes.push(
      capability.set(`voice.locale.${key}`, value, () => {
        // Native settles before publishing its snapshot. Do not retire a newer edit.
        if (desired[key] === value) {
          delete desired[key];
        }
        if (
          desired.primary === undefined &&
          desired.additional === undefined &&
          pendingDeviceLocales.get(capability) === desired
        ) {
          pendingDeviceLocales.delete(capability);
        }
      }),
    );
  }
  return Promise.all(writes);
}

export type VoiceWakeEditorState =
  | { kind: "unavailable" }
  | { kind: "ready"; text: string; phase: "saved" | "pending" | "saving"; error: string | null };

function VoiceWakeControls(props: {
  state: VoiceWakeEditorState;
  onInput: (text: string) => void;
  onRetry: () => void;
}) {
  const ready = () => props.state.kind === "ready";
  const text = () => (props.state.kind === "ready" ? props.state.text : "");
  const error = () => (props.state.kind === "ready" ? props.state.error : null);
  return (
    <>
      {ready() && (
        <textarea
          class="settings-input"
          aria-label={t("configPage.deviceTalk.triggerWords")}
          rows={4}
          value={text()}
          onInput={(event) => props.onInput(event.currentTarget.value)}
        />
      )}
      {error() ? (
        <div class="callout danger" role="alert">
          {error()}
          <button class="btn btn--sm" type="button" onClick={() => props.onRetry()}>
            {t("common.retry")}
          </button>
        </div>
      ) : props.state.kind === "unavailable" ? (
        <span class="muted">{t("configPage.deviceTalk.triggerWordsUnavailable")}</span>
      ) : (
        <span class="muted" role="status">
          {props.state.phase !== "saved" ? t("common.saving") : t("configPage.deviceTalk.saved")}
        </span>
      )}
    </>
  );
}

export function VoiceWakeEditor(props: {
  readState: () => VoiceWakeEditorState;
  scope?: object | null;
  onInput: (text: string) => void;
  onRetry: () => void;
}) {
  return (
    <SettingsSection title={t("configPage.deviceTalk.triggerWords")}>
      <SettingsRow
        title={t("configPage.deviceTalk.triggerWords")}
        description={t("configPage.deviceTalk.triggerWordsHint")}
        stacked
        control={
          <Errored
            fallback={(error, reset) => (
              <div class="callout danger" role="alert">
                {formatUiError(error())}
                <button
                  class="btn btn--sm"
                  type="button"
                  onClick={() => {
                    props.onRetry();
                    reset();
                  }}
                >
                  {t("common.retry")}
                </button>
              </div>
            )}
          >
            <Loading
              on={props.scope}
              fallback={
                <span class="muted" role="status">
                  {t("common.loading")}
                </span>
              }
            >
              <VoiceWakeControls
                state={props.readState()}
                onInput={props.onInput}
                onRetry={props.onRetry}
              />
            </Loading>
          </Errored>
        }
      />
    </SettingsSection>
  );
}

const voiceToggles = [
  "wakeEnabled",
  "wakeTriggersTalkMode",
  "pushToTalkEnabled",
  "talkShiftToStopEnabled",
  "talkPhaseSoundsEnabled",
  "realtimeRelayEnabled",
  "triggerChime",
  "sendChime",
  "talkEnabled",
  "talkButtonEnabled",
  "talkBackgroundEnabled",
  "speakerphoneEnabled",
] as const;

function DeviceVoiceSettings(props: {
  capability: NativeDeviceSettingsCapability;
  snapshot: NativeDeviceSettingsSnapshot;
}) {
  const voice = () => props.snapshot.voice;
  const microphone = () => voice().microphone;
  const microphoneOptions = createMemo(() => {
    const current = microphone();
    const options = [
      { value: "", label: t("configPage.deviceTalk.systemDefault") },
      ...(current?.devices.map(({ id, name }) => ({ value: id, label: name })) ?? []),
    ];
    if (current?.selectedId && !current.devices.some(({ id }) => id === current.selectedId)) {
      options.push({
        value: current.selectedId,
        label: t("configPage.deviceTalk.disconnectedMicrophone", { id: current.selectedId }),
      });
    }
    return options;
  });
  // Choices and selection share one optimistic frame during overlapping native edits.
  const [locale, setLocale] = createOptimistic(() => {
    // Reading the published snapshot invalidates the pending-intent overlay.
    void props.snapshot;
    return deviceLocaleSelection(props.capability);
  });
  // Keep the controls owned by availability, not each optimistic selection frame.
  const hasLocale = createMemo(() => locale() !== null);
  const changeLocales = action(function* (completion: ReturnType<typeof changeDeviceLocales>) {
    setLocale(deviceLocaleSelection(props.capability));
    yield completion;
    // Other edits may still hold this transition open after this write settles.
    setLocale(deviceLocaleSelection(props.capability));
    void refresh(locale);
  });
  return (
    <>
      <For each={voiceToggles} keyed={(key) => key}>
        {(key) => (
          <>
            {voice()[key()] !== undefined && (
              <SettingsToggleRow
                title={t(`configPage.deviceTalk.${key()}`)}
                checked={voice()[key()] ?? false}
                disabled={key() === "wakeEnabled" && !voice().supported && !voice().wakeEnabled}
                description={
                  key() === "wakeEnabled" && !voice().supported
                    ? t(
                        props.snapshot.device.platform === "macos"
                          ? "configPage.deviceTalk.unsupported"
                          : "configPage.deviceTalk.unsupportedDevice",
                      )
                    : key() === "realtimeRelayEnabled"
                      ? t("configPage.deviceTalk.realtimeRelayHint")
                      : undefined
                }
                onChange={(value) => void props.capability.set(`voice.${key()}`, value)}
              />
            )}
          </>
        )}
      </For>
      {microphone() && (
        <SettingsSelectRow
          title={t("configPage.deviceTalk.microphone")}
          value={microphone()?.selectedId ?? ""}
          options={microphoneOptions()}
          onChange={(value) => void props.capability.set("voice.microphone", value || null)}
        />
      )}
      {hasLocale() && (
        <SettingsSelectRow
          title={t("configPage.deviceTalk.primaryLanguage")}
          value={locale()!.primary}
          options={locale()!.available.map(({ id, name }) => ({ value: id, label: name }))}
          onChange={(value) => {
            const current = deviceLocaleSelection(props.capability);
            if (current) {
              void changeLocales(
                changeDeviceLocales(props.capability, {
                  primary: value,
                  ...(current.additional.includes(value)
                    ? { additional: current.additional.filter((id) => id !== value) }
                    : {}),
                }),
              );
            }
          }}
        />
      )}
      {hasLocale() && (
        <SettingsRow
          title={t("configPage.deviceTalk.additionalLanguages")}
          stacked
          control={
            <>
              <For each={locale()!.additional} keyed={(id) => id}>
                {(id) => {
                  const name = () =>
                    locale()?.available.find((language) => language.id === id())?.name ?? id();
                  return (
                    <div>
                      {name()}
                      <button
                        class="btn btn--sm"
                        type="button"
                        aria-label={t("configPage.deviceTalk.removeLanguage", { name: name() })}
                        onClick={() => {
                          const current = deviceLocaleSelection(props.capability);
                          if (current) {
                            void changeLocales(
                              changeDeviceLocales(props.capability, {
                                additional: current.additional.filter((value) => value !== id()),
                              }),
                            );
                          }
                        }}
                      >
                        {t("common.remove")}
                      </button>
                    </div>
                  );
                }}
              </For>
              <select
                class="settings-select"
                aria-label={t("configPage.deviceTalk.addLanguage")}
                onChange={(event) => {
                  const select = event.currentTarget;
                  const current = deviceLocaleSelection(props.capability);
                  if (
                    select.value &&
                    current &&
                    select.value !== current.primary &&
                    !current.additional.includes(select.value)
                  ) {
                    void changeLocales(
                      changeDeviceLocales(props.capability, {
                        additional: [...current.additional, select.value],
                      }),
                    );
                    select.value = "";
                  }
                }}
              >
                <option value="">{t("configPage.deviceTalk.addLanguage")}</option>
                <For
                  each={locale()!.available.filter(
                    ({ id }) => id !== locale()!.primary && !locale()!.additional.includes(id),
                  )}
                  keyed={false}
                >
                  {(option) => <option value={option().id}>{option().name}</option>}
                </For>
              </select>
            </>
          }
        />
      )}
      {microphone() && (
        <SettingsRow
          title={t("configPage.deviceTalk.microphoneTest")}
          control={
            <button
              class="btn btn--sm"
              type="button"
              onClick={() => props.capability.openPanel("microphone-test")}
            >
              {t("configPage.deviceTalk.microphoneTest")}
            </button>
          }
        />
      )}
    </>
  );
}

export function DeviceTalk(props: {
  capability?: NativeDeviceSettingsCapability | null;
  snapshot?: NativeDeviceSettingsSnapshot | null;
}) {
  return (
    <>
      {props.capability && (
        <SettingsSection title={t(deviceSettingsGroupLabelKey(props.snapshot))}>
          {props.snapshot?.voice ? (
            <DeviceVoiceSettings capability={props.capability} snapshot={props.snapshot} />
          ) : (
            <SettingsRow title={t("common.loading")} />
          )}
        </SettingsSection>
      )}
    </>
  );
}
