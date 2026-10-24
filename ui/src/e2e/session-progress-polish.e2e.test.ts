import type { ProgressCard } from "@openclaw/gateway-protocol";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import {
  controlUiBundledSettingsStorageKey,
  defaultControlUiFeatureMethods,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatTaskProgress } from "./chat-details.test-support.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";
import { openProgressHomeDock } from "./session-progress-home.test-support.ts";

const suite = createChatFlowE2eSuite({
  channel: "chromium",
  args: ["--font-render-hinting=none", "--force-color-profile=srgb"],
});
const sessionKey = "agent:main:main";
const steps = [
  { step: "Read the project instructions", status: "completed" },
  {
    step: "Map the dashboard controls and their behavior across desktop and mobile layouts, including long checklist entries that continue onto a second line",
    status: "completed",
  },
  { step: "Check the task progress card", status: "in_progress" },
  ...Array.from({ length: 12 }, (_, index) => ({
    step: `Verify checklist item ${index + 4}`,
    status: "pending",
  })),
];

async function openProgress(page: Page, initialCard?: ProgressCard) {
  const card = initialCard ?? { sessionKey, revision: 1, updatedAt: Date.now(), steps };
  const gateway = await installMockGateway(page, {
    featureMethods: [...defaultControlUiFeatureMethods, "chat.history", "chat.send"],
    sessionKey,
    sessionInfo: { key: sessionKey, hasActiveRun: true, activeRunIds: ["polish-run"] },
    inFlightRun: { runId: "polish-run" },
    methodResponses: { "progressCard.get": { card } },
  });
  await page.goto(`${suite.server.baseUrl}chat`);
  const disclosure = await openChatTaskProgress(page);
  if (
    (await disclosure.getAttribute("data-progress-card-placement")) === "details" &&
    (await disclosure.getAttribute("open")) === null
  ) {
    await disclosure.locator("summary").click();
  }
  await disclosure.locator(".task-progress-details__plan").waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { gateway, card, details: disclosure };
}

suite.define(() => {
  it.each(["no-preference", "reduce"] as const)(
    "keeps four task steps fixed through status changes with %s motion",
    async (reducedMotion) => {
      const context = await suite.newBrowserContext({
        viewport: { width: 1440, height: 900 },
        reducedMotion,
      });
      try {
        const page = await context.newPage();
        const labels = [
          "Read the project instructions and inspect the current task progress behavior",
          "Align the checklist markers with the first line of every wrapped task description",
          "Verify the completed, current, and pending states without shifting the list",
          "Review the screenshots and the validation notes before sharing the proposed change",
        ];
        const card: ProgressCard = {
          sessionKey,
          revision: 1,
          updatedAt: Date.now(),
          markdown:
            "Review the [proposed change](https://example.com/review) and the [validation notes](https://example.com/validation).",
          steps: labels.map((step, index) => ({
            step,
            status: index === 0 ? "in_progress" : "pending",
          })),
        };
        const { gateway, details } = await openProgress(page, card);
        await waitForLayoutSettled(page, ".chat-details, .task-progress-details__plan");
        const rows = details.locator(".session-progress-card__step");
        const measure = () =>
          rows.evaluateAll((elements) =>
            elements.map((row) => {
              const marker = row.querySelector(".session-progress-card__step-marker")!;
              const text = row.querySelector(".session-progress-card__step-text")!;
              const icon = marker.firstElementChild!;
              const bounds = row.getBoundingClientRect();
              const markerBounds = marker.getBoundingClientRect();
              const textBounds = text.getBoundingClientRect();
              const style = getComputedStyle(text);
              const rail = getComputedStyle(row, "::after");
              return {
                geometry: [bounds, markerBounds, textBounds].map(({ x, y, width, height }) => ({
                  x,
                  y,
                  width,
                  height,
                })),
                fontSize: style.fontSize,
                lineHeight: style.lineHeight,
                color: style.color,
                markerColor: getComputedStyle(marker).color,
                iconSize: [getComputedStyle(icon).width, getComputedStyle(icon).height],
                animation: getComputedStyle(icon).animationName,
                firstLineOffset: markerBounds.top - textBounds.top,
                textGap: textBounds.left - markerBounds.right,
                rail: {
                  content: rail.content,
                  x: bounds.left + Number.parseFloat(rail.left),
                  top: bounds.top + Number.parseFloat(rail.top),
                  height: Number.parseFloat(rail.height),
                  width: rail.width,
                  opacity: rail.opacity,
                },
              };
            }),
          );
        const initial = await measure();
        expect(initial).toHaveLength(4);
        expect(initial.some((row) => row.geometry[2]!.height > 20)).toBe(true);
        const palette = await details.evaluate((element) => {
          const color = (token: string) => {
            const probe = document.createElement("span");
            probe.style.color = `var(${token})`;
            element.append(probe);
            const value = getComputedStyle(probe).color;
            probe.remove();
            return value;
          };
          return { text: color("--text"), muted: color("--muted"), success: color("--ok") };
        });
        const links = await details
          .locator(".session-progress-card__markdown a")
          .evaluateAll((elements) => elements.map((link) => getComputedStyle(link).fontWeight));
        expect(links).toEqual(["600", "600"]);
        for (const [index, row] of initial.entries()) {
          expect(row.fontSize).toBe("14px");
          expect(row.lineHeight).toBe("20px");
          expect(row.iconSize).toEqual(["16px", "16px"]);
          expect(row.geometry[1]!.height).toBe(20);
          expect(row.geometry[1]!.width).toBe(16);
          expect(row.firstLineOffset).toBe(0);
          expect(row.textGap).toBe(10);
          if (index === initial.length - 1) {
            expect(row.rail.content).toBe("none");
          } else {
            const next = initial[index + 1]!;
            expect(row.rail.width).toBe("1px");
            expect(row.rail.opacity).toBe("0.5");
            expect(row.rail.x + 0.5).toBe(row.geometry[1]!.x + 8);
            expect(row.rail.top - (row.geometry[1]!.y + 18)).toBe(4);
            expect(next.geometry[1]!.y + 2 - (row.rail.top + row.rail.height)).toBe(4);
          }
        }
        for (let completed = 0; completed <= labels.length; completed += 1) {
          if (completed > 0) {
            await gateway.setMethodResponse("progressCard.get", {
              card: {
                ...card,
                revision: completed + 1,
                steps: labels.map((step, index) => ({
                  step,
                  status:
                    index < completed
                      ? "completed"
                      : index === completed
                        ? "in_progress"
                        : "pending",
                })),
              },
            });
            await gateway.emitGatewayEvent("progressCard.changed", {
              sessionKey,
              revision: completed + 1,
            });
          }
          await expect
            .poll(() => rows.locator('[data-status="completed"]').count())
            .toBe(completed);
          const current = await measure();
          expect(current.map((row) => row.geometry)).toEqual(initial.map((row) => row.geometry));
          for (const [index, row] of current.entries()) {
            const active = index === completed;
            expect(row.color).toBe(active ? palette.text : palette.muted);
            expect(row.markerColor).toBe(
              index < completed ? palette.success : active ? palette.text : palette.muted,
            );
            expect(row.animation).toBe(
              active && reducedMotion === "no-preference" ? "btn-spinner-spin" : "none",
            );
          }
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it.each([
    { width: 1440, touch: false },
    { width: 390, touch: false },
    { width: 390, touch: true },
    { width: 1440, touch: true },
  ])(
    "aligns Details checklists and retains only Home gesture handles at $width px, touch=$touch",
    async ({ width, touch }) => {
      const context = await suite.newBrowserContext({
        viewport: { width, height: 900 },
        deviceScaleFactor: 2,
        hasTouch: touch,
        isMobile: touch,
      });
      try {
        const page = await context.newPage();
        const { gateway, details } = await openProgress(page);
        for (const placement of ["details", "composer"] as const) {
          if (placement === "composer") {
            // A Home dock is suppressed while that same conversation owns the page.
            await page.goto(`${suite.server.baseUrl}new`);
            await openProgressHomeDock(page);
            await gateway.waitForRequest("chat.startup", { match: { sessionKey } });
          }
          const disclosure =
            placement === "details"
              ? details
              : page.locator('[data-progress-card-placement="composer"]');
          await disclosure.waitFor();
          const mobileDetails =
            (await disclosure.getAttribute("data-details-page")) === "task-progress";
          if (!mobileDetails && (await disclosure.getAttribute("open")) === null) {
            await disclosure.locator("summary").click();
          }
          const measurements = await disclosure
            .locator(".session-progress-card__step")
            .evaluateAll((rows) =>
              rows.map((row) => {
                const marker = row.querySelector(".session-progress-card__step-marker > *")!;
                const text = row.querySelector(".session-progress-card__step-text")!;
                const icon = marker.getBoundingClientRect();
                const bounds = text.getBoundingClientRect();
                const line = Number.parseFloat(getComputedStyle(text).lineHeight);
                return {
                  delta: Math.abs(icon.top + icon.height / 2 - (bounds.top + line / 2)),
                  lines: bounds.height / line,
                };
              }),
            );
          expect(measurements).toHaveLength(steps.length);
          expect(measurements.some(({ lines }) => lines > 1.5)).toBe(true);
          for (const { delta } of measurements) {
            expect(delta).toBeLessThanOrEqual(1);
          }
          if (mobileDetails) {
            expect(await disclosure.locator("summary").count()).toBe(0);
            await disclosure
              .getByRole("button", { name: "Task progress options", exact: true })
              .waitFor();
            continue;
          }
          const summary = disclosure.locator(
            placement === "details"
              ? ".task-progress-details__summary"
              : ".session-progress-card__summary",
          );
          const opacity = () => summary.evaluate((el) => getComputedStyle(el, "::before").opacity);
          await page.mouse.move(0, 0);
          expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(!touch);
          if (placement === "details") {
            expect(await summary.evaluate((el) => getComputedStyle(el, "::before").content)).toBe(
              "none",
            );
          } else {
            expect(await opacity()).toBe(touch ? "1" : "0");
          }
          expect(await summary.getAttribute("aria-label")).toBeTruthy();
          expect(await summary.getAttribute("title")).toBeNull();
          if (!touch && placement === "composer") {
            await summary.hover();
            expect(await opacity()).toBe("1");
            await disclosure.locator(".session-progress-card__step-text").first().hover();
            expect(await opacity()).toBe("1");
            await page.mouse.move(0, 0);
            await summary.press("Tab");
            await page.keyboard.press("Shift+Tab");
            expect(await summary.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
            expect(await opacity()).toBe("1");
          }
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it.each(["light", "dark"] as const)(
    "keeps Details unmasked and preserves the compact Home unread fade in %s",
    async (mode) => {
      const context = await suite.newBrowserContext({ viewport: { width: 1440, height: 900 } });
      try {
        await context.addInitScript(
          ({ key, theme }) =>
            localStorage.setItem(key, JSON.stringify({ theme, themeMode: theme })),
          { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), theme: mode },
        );
        const page = await context.newPage();
        const { gateway, card } = await openProgress(page);
        const detailsCard = page.locator('[data-progress-card-placement="details"]');
        const detailsBody = detailsCard.locator(".task-progress-details__body");
        expect(await detailsBody.evaluate((el) => getComputedStyle(el).maxHeight)).toBe("none");
        expect(await detailsBody.evaluate((el) => getComputedStyle(el).overflowY)).toBe("visible");
        expect(await detailsBody.evaluate((el) => getComputedStyle(el).maskImage)).toBe("none");
        const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
        const readerTop = await thread.evaluate((el) => el.scrollTop);
        await detailsCard.locator(".session-progress-card__step").last().scrollIntoViewIfNeeded();
        expect(await detailsBody.evaluate((el) => el.scrollTop)).toBe(0);
        expect(await thread.evaluate((el) => el.scrollTop)).toBe(readerTop);
        // Keep the Home identity, but release its full-page presentation before docking.
        await page.goto(`${suite.server.baseUrl}new`);
        await openProgressHomeDock(page);
        await gateway.waitForRequest("chat.startup", { match: { sessionKey } });
        const home = page.locator("openclaw-home-session");
        const disclosure = home.locator('[data-progress-card-placement="composer"]');
        await disclosure.waitFor();
        if ((await disclosure.getAttribute("open")) === null) {
          await disclosure.locator("summary").click();
        }
        await disclosure.locator(".session-progress-card__summary").focus();
        const frame = await disclosure.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            width: style.borderTopWidth,
            color: style.borderTopColor,
            shadow: style.boxShadow,
          };
        });
        expect(frame.width).toBe("1px");
        expect(frame.color).not.toBe("rgba(0, 0, 0, 0)");
        expect(frame.shadow).toBe("none");
        if (mode === "light") {
          const composerShadow = await home
            .locator(".agent-chat__input")
            .evaluate((element) => getComputedStyle(element).boxShadow);
          expect(composerShadow.startsWith(`${frame.color} 0px 0px 0px 1px`)).toBe(true);
        }
        const body = disclosure.locator(".session-progress-card__body");
        const mask = () => body.evaluate((el) => getComputedStyle(el).maskImage);
        const height = () => body.evaluate((el) => el.clientHeight);
        const initialHeight = await height();
        expect(await body.evaluate((el) => el.scrollHeight)).toBeGreaterThan(initialHeight);
        await expect.poll(mask).not.toBe("none");
        await body.hover();
        await page.mouse.wheel(0, 1000);
        await expect.poll(mask).toBe("none");
        expect(await height()).toBe(initialHeight);
        await page.mouse.wheel(0, -1000);
        await expect.poll(mask).not.toBe("none");
        expect(await height()).toBe(initialHeight);
        const revise = async (revision: number, nextSteps: typeof steps) => {
          await gateway.setMethodResponse("progressCard.get", {
            card: { ...card, revision, steps: nextSteps },
          });
          await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision });
        };
        await revise(2, steps.slice(0, 1));
        await expect.poll(mask).toBe("none");
        await revise(3, steps);
        await expect.poll(mask).not.toBe("none");
        await disclosure.locator(".session-progress-card__summary").click();
        await disclosure.locator(".session-progress-card__summary").click();
        await expect.poll(mask).not.toBe("none");
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
