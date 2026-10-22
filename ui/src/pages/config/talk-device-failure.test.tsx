/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { createNativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import { projectNativeDeviceSettings } from "../../lib/reactive/application-native.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createNativeDeviceSettingsSnapshot } from "../../test-helpers/native-device-settings.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { DeviceTalk } from "./talk-device.tsx";

it("retains a rejected native language edit and retries it visibly", async () => {
  const snapshot = createNativeDeviceSettingsSnapshot();
  const post = vi.fn<(message: unknown) => Promise<unknown>>().mockResolvedValue(snapshot);
  vi.stubGlobal("webkit", {
    messageHandlers: { openclawDeviceSettings: { postMessage: post } },
  });
  vi.stubGlobal("__OPENCLAW_NATIVE_DEVICE_SETTINGS__", snapshot);
  const capability = createNativeDeviceSettingsCapability()!;
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const retired = new Promise<void>(() => {});
  const view = mountSolid(() => {
    const device = projectNativeDeviceSettings(capability);
    return (
      <DeviceTalk
        capability={capability}
        snapshot={device.read()}
        presentationRetired={() => retired}
      />
    );
  });
  const page = view.container;
  const failed = Promise.withResolvers<unknown>();
  post.mockReturnValueOnce(failed.promise);
  try {
    const primary = await waitForSolid(() => {
      const select = page.querySelector<HTMLSelectElement>('select[aria-label="Primary language"]');
      expect(select).not.toBeNull();
      return select!;
    });
    primary.value = "de-DE";
    primary.dispatchEvent(new Event("change"));
    failed.reject(new Error("Native language write unavailable"));
    await waitForSolid(() => {
      expect(page.querySelector('[role="alert"]')?.textContent).toContain(
        "Native language write unavailable",
      );
      expect(primary.value).toBe("de-DE");
    });
    expect(capability.snapshot?.voice.locale?.primary).toBe("en-US");
    const accepted = createNativeDeviceSettingsSnapshot();
    accepted.voice.locale.primary = "de-DE";
    post.mockResolvedValueOnce(accepted);
    page.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    await waitForSolid(() => {
      expect(capability.snapshot?.voice.locale?.primary).toBe("de-DE");
      expect(primary.value).toBe("de-DE");
      expect(page.querySelector('[role="alert"]')).toBeNull();
    });
    expect(post).toHaveBeenCalledTimes(3);
    expect(post).toHaveBeenNthCalledWith(2, {
      type: "set",
      key: "voice.locale.primary",
      value: "de-DE",
    });
    expect(post).toHaveBeenNthCalledWith(3, {
      type: "set",
      key: "voice.locale.primary",
      value: "de-DE",
    });
  } finally {
    view.unmount();
    capability.dispose();
    warning.mockRestore();
    vi.unstubAllGlobals();
  }
});
