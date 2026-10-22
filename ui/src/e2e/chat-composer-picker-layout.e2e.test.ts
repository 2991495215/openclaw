import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiElementScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI composer picker layout" });

suite.define(() => {
  it("keeps Send and Stop equally sized and reachable across active-run draft states", async () => {
    const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const artifactDir = artifactRoot
      ? createControlUiE2eArtifactDir("composer-primary-targets", artifactRoot)
      : undefined;
    await suite.withPage({ viewport: { width: 1280, height: 729 } }, async ({ page }) => {
      const runId = "composer-layout-active-run";
      const gateway = await installMockGateway(page, {
        sessionKey: "agent:main:main",
        sessionInfo: { key: "agent:main:main", activeRunIds: [runId], hasActiveRun: true },
        inFlightRun: { runId, text: "Reviewing the composer layout." },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const composer = page.locator(".agent-chat__input");
      for (const width of [1280, 1100, 393, 560, 320]) {
        await page.setViewportSize({ width, height: 729 });
        if (width === 1100) {
          await openChatSidePanelType(page, "Files");
          await page.locator(".chat-workspace-rail").waitFor();
          await expect
            .poll(() => composer.evaluate((node) => node.getBoundingClientRect().width))
            .toBeLessThan(360);
        }
        const measureAction = async (action: "stop" | "send") => {
          await composer.locator("textarea").fill(action === "send" ? "Review this follow-up" : "");
          const primary = composer.locator(`.chat-send-btn--${action}`);
          await expect.poll(() => primary.isVisible()).toBe(true);
          await expect.poll(() => primary.isEnabled()).toBe(true);
          const geometry = await primary.evaluate((node) => {
            const rect = node.getBoundingClientRect();
            const icon = node.querySelector("svg")!.getBoundingClientRect();
            const footer = node.closest(".agent-chat__composer-footer")!.getBoundingClientRect();
            return {
              width: rect.width,
              height: rect.height,
              iconWidth: icon.width,
              iconHeight: icon.height,
              centerY: rect.y + rect.height / 2,
              contained:
                rect.left >= footer.left - 1 &&
                rect.right <= footer.right + 1 &&
                rect.top >= footer.top - 1 &&
                rect.bottom <= footer.bottom + 1,
              reachable: node.contains(
                document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
              ),
            };
          });
          expect(geometry.contained, `${action} stays in the footer at ${width}px`).toBe(true);
          expect(geometry.reachable, `${action} hit target at ${width}px`).toBe(true);
          if (width !== 1280 && action === "stop") {
            expect(geometry.iconWidth, `compact Stop glyph at ${width}px`).toBeCloseTo(18, 2);
            expect(geometry.iconHeight, `compact Stop glyph at ${width}px`).toBeCloseTo(18, 2);
          }
          if (artifactDir) {
            await writeFile(
              `${artifactDir}/composer-${width}-${action}.png`,
              await takeControlUiElementScreenshot(page, composer, [primary]),
            );
          }
          return geometry;
        };
        // The primary slot changes action with the draft. Compare its rendered
        // bounds across states; the smaller square stop glyph is intentional.
        const stop = await measureAction("stop");
        const send = await measureAction("send");
        if (artifactDir) {
          await writeFile(
            `${artifactDir}/composer-${width}-geometry.json`,
            JSON.stringify({ viewportWidth: width, stop, send }, null, 2),
          );
        }
        expect(stop.width, `primary width at ${width}px`).toBeCloseTo(send.width, 2);
        expect(stop.height, `primary height at ${width}px`).toBeCloseTo(send.height, 2);
        expect(stop.width, `square primary control at ${width}px`).toBeCloseTo(stop.height, 2);
        expect(
          Math.abs(stop.centerY - send.centerY),
          `primary center at ${width}px`,
        ).toBeLessThanOrEqual(1);
        if (width === 1100) {
          await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
          await page.locator(".chat-workspace-rail").waitFor({ state: "hidden" });
        }
      }
    });
  });

  it("keeps model and effort targets separate when Files narrows the composer", async () => {
    const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const artifactDir = artifactRoot
      ? createControlUiE2eArtifactDir("composer-picker-targets", artifactRoot)
      : undefined;
    // Keep the shell desktop-sized; Files supplies the narrow composer.
    await suite.withPage({ viewport: { width: 1100, height: 729 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai", reasoning: true }],
        sessions: [
          createControlUiSessionRow("agent:main:main", "Main", 1, {
            contextTokens: 200_000,
            thinkingLevel: "medium",
            thinkingLevels: [
              { id: "low", label: "low" },
              { id: "medium", label: "medium" },
              { id: "high", label: "high" },
            ],
            totalTokens: 21_000,
            totalTokensFresh: true,
          }),
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const composer = page.locator(".agent-chat__input");
      await composer.locator('[data-chat-thinking-select="true"]').waitFor();
      await openChatSidePanelType(page, "Files");
      await page.locator(".chat-workspace-rail").waitFor();
      await expect
        .poll(() => composer.evaluate((node) => node.getBoundingClientRect().width))
        .toBeLessThan(360);

      const contextLayouts = [];
      for (const width of [1100, 1280, 560, 393, 320]) {
        if (width === 560) {
          await selectChatLayoutAction(page, /^(Side panel|Minimize side panel)$/);
          await page.locator(".chat-workspace-rail").waitFor({ state: "hidden" });
        }
        await page.setViewportSize({ width, height: 729 });
        await page.mouse.move(0, 0);
        if (artifactDir) {
          await writeFile(
            `${artifactDir}/composer-${width}.png`,
            await takeControlUiElementScreenshot(page, composer, []),
          );
        }
        await expect
          .poll(() =>
            composer.locator(".agent-chat__composer-footer").evaluate((footer, viewportWidth) => {
              const bounds = footer.getBoundingClientRect();
              const controls = [
                ...footer.querySelectorAll<HTMLElement>(
                  ".agent-chat__input-btn--attach, [data-chat-permission-select], .context-ring, " +
                    "[data-chat-model-select], [data-chat-thinking-select], .chat-send-btn",
                ),
              ]
                .map((node) => ({ node, rect: node.getBoundingClientRect() }))
                .filter(({ node, rect }) => node.checkVisibility() && rect.width > 0);
              return controls.flatMap(({ node, rect }, index) => {
                const label = node.getAttribute("aria-label") ?? node.className;
                const violations =
                  rect.left < bounds.left - 1 || rect.right > bounds.right + 1
                    ? [`${label} leaves the footer`]
                    : [];
                if (
                  viewportWidth <= 560 &&
                  !node.matches("[data-chat-model-select], [data-chat-thinking-select]")
                ) {
                  if (Math.abs(rect.width - 36) > 1 || Math.abs(rect.height - 36) > 1) {
                    violations.push(`${label} does not share the mobile 36px target`);
                  }
                  const icon = node.querySelector("svg")?.getBoundingClientRect();
                  if (!icon || Math.abs(icon.width - 20) > 1 || Math.abs(icon.height - 20) > 1) {
                    violations.push(`${label} does not share the mobile 20px icon`);
                  }
                }
                for (const other of controls.slice(index + 1)) {
                  if (
                    Math.min(rect.right, other.rect.right) - Math.max(rect.left, other.rect.left) >
                      1 &&
                    Math.min(rect.bottom, other.rect.bottom) - Math.max(rect.top, other.rect.top) >
                      1
                  ) {
                    violations.push(`${label} overlaps ${other.node.getAttribute("aria-label")}`);
                  }
                }
                return violations;
              });
            }, width),
          )
          .toEqual([]);
        contextLayouts.push(
          await composer.evaluate((node) => {
            const ring = node.querySelector<HTMLElement>(".context-ring")!;
            const model = node.querySelector<HTMLElement>("[data-chat-model-select]")!;
            const ringBox = ring.getBoundingClientRect();
            const modelBox = model.getBoundingClientRect();
            return {
              label: ring.textContent?.trim(),
              accessibleName: ring.getAttribute("aria-label"),
              gap: modelBox.left - ringBox.right,
              centerOffset: Math.abs(
                ringBox.y + ringBox.height / 2 - (modelBox.y + modelBox.height / 2),
              ),
            };
          }),
        );
        for (const [triggerSelector, menuSelector, otherMenuSelector] of [
          [
            '[data-chat-model-select="true"]',
            ".chat-controls__model-menu",
            ".chat-controls__effort-menu",
          ],
          [
            '[data-chat-thinking-select="true"]',
            ".chat-controls__effort-menu",
            ".chat-controls__model-menu",
          ],
        ] as const) {
          const trigger = composer.locator(triggerSelector);
          await expect
            .poll(() =>
              trigger.evaluate((node) => {
                const rect = node.getBoundingClientRect();
                return node.contains(
                  document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
                );
              }),
            )
            .toBe(true);
          const box = await trigger.boundingBox();
          if (!box) {
            throw new Error(`Missing picker target at viewport ${width}`);
          }
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          await expect.poll(() => composer.locator(menuSelector).isVisible()).toBe(true);
          expect(await composer.locator(otherMenuSelector).isVisible()).toBe(false);
          await page.keyboard.press("Escape");
          await expect.poll(() => composer.locator(menuSelector).isVisible()).toBe(false);
        }
      }
      for (const layout of contextLayouts) {
        expect(layout.label).toBe("");
        expect(layout.accessibleName).toBe("Session context usage: 21k of 200k (11%)");
        expect(layout.gap).toBeGreaterThanOrEqual(0);
        expect(layout.gap).toBeLessThanOrEqual(8);
        expect(layout.centerOffset).toBeLessThanOrEqual(1);
      }
    });
  });
});
