import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  captureUiProofEnabled,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import { readOutboxQueue } from "./chat-outbox-payloads.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const title = "Which audience should the summary address?";
const questionMessage = {
  role: "assistant",
  __openclaw: { id: "audience-prompt", seq: 1 },
  content: `${title}\n\n1. Engineers\n2. Everyone`,
  timestamp: 1_789_000_000_000,
  openclawAsyncDelivery: {
    itemId: "audience-question",
    questions: [{ title, options: ["Engineers", "Everyone"] }],
  },
};

suite.define(() => {
  it("reopens a withdrawn shared answer in the submitting and another mounted viewer", async () => {
    const contexts = await Promise.all([
      suite.newBrowserContext(createControlUiE2eContextOptions()),
      suite.newBrowserContext(createControlUiE2eContextOptions()),
    ]);
    try {
      const pages = await Promise.all(contexts.map((context) => context.newPage()));
      const gateways = await Promise.all(
        pages.map((page) => installMockGateway(page, { historyMessages: [questionMessage] })),
      );
      await Promise.all(pages.map((page) => page.goto(suite.server.baseUrl + "chat")));
      const cards = pages.map((page) =>
        page.locator(".agent-chat__question-dock openclaw-chat-question-panel"),
      );
      await Promise.all(cards.map((card) => expectBrowser(card).toBeVisible()));
      await gateways[0]!.deferNext("chat.send");
      await cards[0]!.getByRole("button", { name: "Submit", exact: true }).click();
      const first = await gateways[0]!.waitForRequest("chat.send");
      const runId = requireString(requireRecord(first.params).idempotencyKey, "submitted run ID");
      const input = {
        id: "withdrawn-answer",
        runId,
        state: "queued",
        queued: true,
        acceptedAt: Date.now(),
        message: {
          role: "user",
          content: "> " + title + "\n\nEngineers",
          __openclaw: { replyToId: "audience-prompt", asyncQuestionItemId: "audience-question" },
        },
      };
      const history = {
        sessionId: "session:agent:main:main",
        messages: [questionMessage],
        sessionInfo: {
          key: "agent:main:main",
          sessionId: "session:agent:main:main",
          status: "done",
          hasActiveRun: false,
        },
        pendingInputs: { items: [input], total: 1, queuedCount: 1 },
        inputReceipts: [{ runId, state: "pending", queued: true }],
      };
      for (const gateway of gateways) {
        await gateway.setMethodResponse("chat.history", history);
      }
      await gateways[0]!.resolveDeferred("chat.send", { runId, status: "queued" });
      for (const gateway of gateways) {
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey: "agent:main:main",
          agentId: "main",
          reason: "send",
        });
      }
      for (const page of pages) {
        await expectBrowser(page.locator(".chat-question-summary")).toContainText("Answer queued");
        await expectBrowser(page.locator(".agent-chat__question-dock")).toHaveCount(0);
      }
      await gateways[0]!.deferNext("chat.abort");
      await pages[0]!
        .locator(".chat-queue__item")
        .getByRole("button", { name: "Remove queued message" })
        .click();
      expect((await gateways[0]!.waitForRequest("chat.abort")).params).toMatchObject({
        runId,
        discardPendingInput: true,
      });
      await expectBrowser(cards[0]!).toHaveCount(0);
      const cancelled = {
        ...history,
        pendingInputs: {
          items: [
            {
              ...input,
              state: "cancelled",
              queued: undefined,
              message: {
                role: "user",
                content: [],
                display: false,
                __openclaw: { id: "pending:withdrawn-answer" },
              },
            },
          ],
          total: 1,
          queuedCount: 0,
        },
        inputReceipts: [{ runId, state: "pending", cancelled: true }],
      };
      for (const gateway of gateways) {
        await gateway.setMethodResponse("chat.history", cancelled);
      }
      await gateways[0]!.resolveDeferred("chat.abort", { aborted: true, runIds: [runId] });
      await gateways[1]!.emitGatewayEvent("sessions.changed", {
        sessionKey: "agent:main:main",
        agentId: "main",
        reason: "send",
      });
      for (const page of pages) {
        await expectBrowser(page.locator(".chat-queue__item")).toHaveCount(0);
      }
      await expectBrowser(cards[1]!).toBeVisible();
      await expectBrowser(cards[0]!).toBeVisible();
      expect(await gateways[0]!.getRequests("chat.send")).toHaveLength(1);
      expect(await gateways[1]!.getRequests("chat.send")).toHaveLength(0);
    } finally {
      await Promise.all(contexts.map((context) => suite.closeBrowserContext(context)));
    }
  });

  it("shows another viewer's accepted queued answer after reload instead of another popup", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const sourceMessageId = "shared-audience-prompt";
      const question = { ...questionMessage, __openclaw: { id: sourceMessageId, seq: 1 } };
      const pending = {
        id: "shared-answer",
        runId: "other-viewer-answer",
        state: "queued",
        queued: true,
        acceptedAt: 1_789_000_001_000,
        message: {
          role: "user",
          content: "> " + title + "\n\nEngineers",
          __openclaw: { replyToId: sourceMessageId },
        },
      };
      const history = {
        sessionId: "session:agent:main:main",
        messages: [question],
        sessionInfo: {
          key: "agent:main:main",
          sessionId: "session:agent:main:main",
          status: "done",
          hasActiveRun: false,
        },
        pendingInputs: { items: [pending], total: 1, queuedCount: 1 },
      };
      const gateway = await installMockGateway(page, {
        historyMessages: [question],
        methodResponses: {
          "chat.startup": { ...history, pendingInputs: { items: [], total: 0, queuedCount: 0 } },
        },
      });
      await page.goto(suite.server.baseUrl + "chat");
      await expectBrowser(page.locator(".agent-chat__question-dock")).toBeVisible();
      await gateway.setMethodResponse("chat.startup", history);
      await gateway.setMethodResponse("chat.history", history);
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey: "agent:main:main",
        agentId: "main",
        reason: "send",
      });
      const queued = page.locator(".chat-queue__item").filter({ hasText: "Engineers" });
      await expectBrowser(queued).toBeVisible();
      if (captureUiProofEnabled) {
        const dir = createControlUiE2eArtifactDir("shared-async-answer", suite.artifactDir);
        const frame = await takeControlUiScreenshotFrame(
          page,
          page.locator("openclaw-chat-pane"),
          [queued],
          { animations: "disabled" },
        );
        await writeFile(path.join(dir, "shared-queued.png"), frame.png);
      }
      const dock = page.locator(".agent-chat__question-dock");
      await expectBrowser(dock).toHaveCount(0);
      const summary = page.locator(".chat-question-summary");
      await expectBrowser(summary).toContainText("Engineers");
      await expectBrowser(summary).toContainText("Answer queued");
      await page.reload();
      await expectBrowser(summary).toContainText("Engineers");
      await expectBrowser(summary).toContainText("Answer queued");
      await expectBrowser(dock).toHaveCount(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      const confirmed = {
        role: "user",
        content: pending.message.content,
        __openclaw: {
          id: "canonical-answer",
          seq: 2,
          replyToId: sourceMessageId,
          asyncQuestionItemId: "audience-question",
        },
      };
      await gateway.emitGatewayEvent("session.message", {
        sessionKey: "agent:main:main",
        messageId: "canonical-answer",
        messageSeq: 2,
        message: confirmed,
      });
      await expectBrowser(summary).toContainText("Answer sent");
      await expectBrowser(dock).toHaveCount(0);
    });
  });

  it("reconciles a stale second submit to the server's accepted answer without retrying its bytes", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, { historyMessages: [questionMessage] });
      await page.goto(suite.server.baseUrl + "chat");
      const card = page.locator(".agent-chat__question-dock openclaw-chat-question-panel");
      await gateway.deferNext("chat.send");
      await card.getByRole("button", { name: "Submit", exact: true }).click();
      const submitted = await gateway.waitForRequest("chat.send");
      expect(submitted.params).toMatchObject({
        replyToId: "audience-prompt",
        asyncQuestionItemId: "audience-question",
      });
      const pending = {
        id: "winner",
        runId: "other-viewer",
        state: "queued",
        queued: true,
        acceptedAt: Date.now(),
        message: {
          role: "user",
          content: "> " + title + "\n\nEveryone",
          __openclaw: { replyToId: "audience-prompt", asyncQuestionItemId: "audience-question" },
        },
      };
      await gateway.setMethodResponse("chat.history", {
        sessionId: "session:agent:main:main",
        messages: [questionMessage],
        sessionInfo: {
          key: "agent:main:main",
          sessionId: "session:agent:main:main",
          status: "done",
          hasActiveRun: false,
        },
        pendingInputs: { items: [pending], total: 1, queuedCount: 1 },
      });
      await gateway.rejectDeferred("chat.send", {
        code: "INVALID_REQUEST",
        message: "This question already has an accepted answer.",
        details: { reason: "async-question-already-answered" },
      });
      await expectBrowser(page.locator(".chat-question-summary")).toContainText("Everyone");
      await expectBrowser(page.locator(".chat-question-summary")).toContainText("Answer queued");
      await expectBrowser(card).toHaveCount(0);
      await expect.poll(async () => await readOutboxQueue(page)).toHaveLength(0);
      await expectBrowser(
        page.locator(".chat-group.user").filter({ hasText: "Engineers" }),
      ).toHaveCount(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
    });
  });
});
