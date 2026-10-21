import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  installMockGateway,
  defaultControlUiFeatureMethods,
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  installPreferenceServer,
  captureFrame,
  seedStorage,
} from "./sidebar-assertions.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Personal rail pins" });
suite.define(() => {
  it("opens a touch-held pin without navigating or collapsing, while taps still navigate", async () => {
    await suite.withPage(
      { hasTouch: true, viewport: { width: 1280, height: 800 } },
      async ({ page }) => {
        await installMockGateway(page, {
          sessionKey: "agent:main:current",
          sessions: [
            { key: "agent:main:current", kind: "direct", label: "Current work" },
            { key: "agent:main:design", kind: "direct", label: "Design ideas" },
          ],
        });
        await seedStorage(page, {
          [controlUiBundledSettingsStorageKey(suite.server.baseUrl)]: JSON.stringify({
            railShortcuts: ["route:cron"],
          }),
        });
        await page.goto(suite.server.baseUrl + "chat");
        const pin = page.locator(".sidebar-rail").locator('[data-sidebar-entry="route:cron"] a');
        await pin.waitFor();
        const initialUrl = page.url();
        const menu = page.locator(".sidebar-rail-pin-menu");
        const box = await pin.boundingBox();
        if (!box) {
          throw new Error("Missing touch pin bounds");
        }
        const touch = {
          pointerId: 1,
          pointerType: "touch",
          isPrimary: true,
          clientX: box.x + box.width / 2,
          clientY: box.y + box.height / 2,
        };
        await page.clock.install();
        await pin.dispatchEvent("pointerdown", touch);
        await page.clock.fastForward(500);
        await menu.getByRole("menuitem", { name: "Unpin", exact: true }).waitFor();
        await pin.dispatchEvent("pointerup", touch);
        // PointerEvent dispatch does not synthesize the compatibility click.
        await pin.dispatchEvent("click", { ...touch, detail: 1 });
        expect(page.url()).toBe(initialUrl);
        expect(await page.locator(".shell--nav-collapsed").count()).toBe(0);
        await page.keyboard.press("Escape");
        await menu.waitFor({ state: "hidden" });

        for (const cancelled of [
          "move",
          "pointerup",
          "pointercancel",
          "dragstart",
          "secondary",
        ] as const) {
          await pin.dispatchEvent("pointerdown", {
            ...touch,
            isPrimary: cancelled !== "secondary",
          });
          if (cancelled === "move") {
            await pin.dispatchEvent("pointermove", { ...touch, clientX: touch.clientX + 9 });
          } else if (cancelled !== "secondary") {
            await pin.dispatchEvent(cancelled, touch);
          }
          await page.clock.fastForward(600);
          expect(await menu.count(), cancelled).toBe(0);
          await pin.dispatchEvent("pointerup", touch);
          if (cancelled === "dragstart") {
            await pin.dispatchEvent("dragend");
          }
        }
        expect(page.url()).toBe(initialUrl);
        await pin.tap();
        await expect.poll(() => page.url()).toContain("automations");
        await page.locator(".shell--nav-collapsed").waitFor();
        expect(await menu.count()).toBe(0);
      },
    );
  });

  it.each([
    { name: "desktop-dark", width: 1280, height: 900, theme: "dark", mobile: false },
    { name: "desktop-light", width: 1280, height: 900, theme: "light", mobile: false },
    { name: "mobile-dark", width: 390, height: 844, theme: "dark", mobile: true },
    { name: "mobile-light", width: 390, height: 844, theme: "light", mobile: true },
  ] as const)("keeps personal sessions together and persists their order ($name)", async (view) => {
    await suite.withPage(
      {
        viewport: { width: view.width, height: view.height },
        hasTouch: view.mobile,
        colorScheme: view.theme,
      },
      async ({ page }) => {
        const keys = ["agent:main:launch", "agent:main:design", "agent:main:notes"];
        const rows = keys.map((key, index) => ({
          key,
          kind: "direct" as const,
          label: ["Launch planning", "Design review", "Release notes"][index]!,
          icon: ["🚀", "🎨", "📝"][index]!,
        }));
        const gateway = await installMockGateway(page, {
          sessionKey: keys[0],
          assistantName: "Atlas",
          heldMethods: ["connect"],
          sessions: rows,
          historyMessages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Keep the launch plan and design review close while we prepare the release.",
                },
              ],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "The launch checklist is ready. Design review and release notes are separate conversations in Sessions.",
                },
              ],
            },
          ],
          presenceUsers: [{ id: "alex", name: "Alex", self: true }],
          featureMethods: [...defaultControlUiFeatureMethods, "users.prefs.get", "users.prefs.set"],
        });
        const preferences = () =>
          installPreferenceServer(
            page,
            { "ui.themeMode": view.theme, "ui.railShortcuts": ["route:cron"] },
            "openclaw-test:pinned-sessions:profile-prefs",
          );
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, keys[0]!));
        await gateway.waitForRequest("connect");
        await preferences();
        await gateway.resolveDeferred("connect");
        const sidebar = page.locator("openclaw-app-sidebar");
        const rail = sidebar.locator(".sidebar-rail");
        const pinned = sidebar.locator('[data-session-section="pinned"]');
        const row = (index: number) =>
          sidebar.locator(`.sidebar-recent-session[data-session-key="${keys[index]}"]`);
        const reveal = async () => {
          if (view.mobile && !(await page.locator(".shell--nav-drawer-open").count())) {
            await page
              .locator(".chat-pane-cache__pane--active")
              .getByRole("button", { name: "Expand sidebar", exact: true })
              .click();
            await page.locator(".shell--nav-drawer-open").waitFor();
          }
        };
        const pinAction = async (index: number, pin: boolean) => {
          const label = pin ? "Pin session" : "Unpin session";
          if (view.mobile) {
            await row(index).locator("[data-sidebar-session-menu]").click();
            await page.getByRole("menuitem", { name: label, exact: true }).click();
          } else {
            await row(index).hover();
            await row(index).getByRole("button", { name: label, exact: true }).click();
          }
        };
        await reveal();
        await row(0).waitFor();
        const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
        const dir = capture
          ? createControlUiE2eArtifactDir(
              `pinned-${view.name}`,
              process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR,
            )
          : null;
        const shot = async (name: string) => {
          if (!dir) {
            return;
          }
          await captureFrame(dir, `${name}-context.png`, page.locator(".shell"), [rail, row(0)]);
          await sidebar
            .locator(".sidebar")
            .screenshot({ path: `${dir}/${name}-sidebar.png`, animations: "disabled" });
        };
        expect(await pinned.count()).toBe(0);
        await pinAction(0, true);
        await expect
          .poll(() => row(0).locator("[data-sidebar-session-pin]").getAttribute("aria-label"))
          .toBe("Unpin session");
        if (!view.mobile) {
          await row(0).hover();
          await row(0).getByRole("button", { name: "Unpin session", exact: true }).hover();
        }
        await shot("filled");
        if (process.env.OPENCLAW_PIN_PROOF_STAGE === "before") {
          return;
        }
        await pinned.waitFor();
        expect(await rail.locator('[data-sidebar-entry^="session:"]').count()).toBe(0);
        expect(await pinned.locator(".sidebar-recent-session").count()).toBe(1);
        expect(await row(0).count()).toBe(1);
        await rail.locator('[data-sidebar-entry="route:cron"]').waitFor();
        expect(
          await sidebar
            .locator("[data-session-section]")
            .first()
            .getAttribute("data-session-section"),
        ).toBe("pinned");
        // A session drag cannot add a rail shortcut or expose the old rail dropzone.
        await row(1).dragTo(rail.locator(".sidebar-rail__pins"));
        expect(await rail.locator('[data-sidebar-entry^="session:"]').count()).toBe(0);
        expect(await rail.locator(".sidebar-rail__pins--drag-active").count()).toBe(0);
        if (!view.mobile) {
          const source = await row(1).boundingBox();
          const target = await row(0).boundingBox();
          if (!source || !target) {
            throw new Error("Missing session drag bounds");
          }
          await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
          await page.mouse.down();
          await page.mouse.move(source.x + source.width / 2 + 12, source.y + source.height / 2, {
            steps: 3,
          });
          await page.mouse.move(target.x + target.width / 2, target.y + target.height - 3, {
            steps: 8,
          });
          // Chromium enters a native drag before its next pointer move emits dragover.
          await page.mouse.move(target.x + target.width / 2, target.y + target.height - 2);
          await row(0).and(page.locator(".sidebar-zone-entry--drop-after")).waitFor();
          expect(
            await pinned.evaluate((element) => ({
              outline: getComputedStyle(element).outlineStyle,
              shadow: getComputedStyle(element).boxShadow,
            })),
          ).toEqual({ outline: "none", shadow: "none" });
          expect(await rail.locator(".sidebar-rail__pins--drag-active").count()).toBe(0);
          await shot("drag");
          await page.mouse.up();
        } else {
          await pinAction(1, true);
        }
        const order = () =>
          pinned
            .locator(".sidebar-recent-session")
            .evaluateAll((elements) =>
              elements.map((element) => element.getAttribute("data-session-key")),
            );
        await expect.poll(order).toEqual(keys.slice(0, 2));
        if (view.mobile) {
          await row(1).locator("[data-sidebar-session-menu]").click();
          await page.getByRole("menuitem", { name: "Move up", exact: true }).click();
        } else {
          await row(1).dragTo(row(0), { targetPosition: { x: 80, y: 2 } });
        }
        await expect.poll(order).toEqual([keys[1], keys[0]]);
        await expect
          .poll(async () => (await gateway.getRequests("users.prefs.set")).at(-1)?.params)
          .toMatchObject({
            entries: {
              "ui.railShortcuts": ["route:cron", `session:${keys[1]}`, `session:${keys[0]}`],
            },
          });
        await page.reload();
        await gateway.waitForRequest("connect");
        await preferences();
        await gateway.resolveDeferred("connect");
        await reveal();
        await expect.poll(order).toEqual([keys[1], keys[0]]);
        await row(1).locator("a.sidebar-recent-session__link").click();
        await expect.poll(() => page.url()).toContain("design");
        if (view.mobile) {
          await page.locator(".shell--nav-drawer-open").waitFor({ state: "hidden" });
          await reveal();
        } else {
          expect(await page.locator(".shell--nav-collapsed").count()).toBe(0);
        }
        await pinAction(1, false);
        await expect.poll(order).toEqual([keys[0]]);
        await pinAction(0, false);
        await expect.poll(() => pinned.count()).toBe(0);
        expect(await row(0).count()).toBe(1);
        expect(await row(1).count()).toBe(1);
        if (view.name === "desktop-dark") {
          await shot("empty");
        }
        expect(await gateway.getRequests("sessions.patch")).toEqual([]);
      },
    );
  });
});
