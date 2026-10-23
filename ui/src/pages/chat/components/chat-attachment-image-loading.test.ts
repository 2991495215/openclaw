// @vitest-environment jsdom

import { expect, it, onTestFinished, vi } from "vitest";
import { ChatAttachmentReadLifecycle, readChatAttachmentFile } from "./chat-attachment-reads.ts";

const imageImport = vi.hoisted(() => ({
  started: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
  resize: vi.fn(),
}));

vi.mock("./chat-attachment-image.ts", async (importOriginal) => {
  imageImport.started.resolve();
  await imageImport.release.promise;
  const actual = await importOriginal<typeof import("./chat-attachment-image.ts")>();
  imageImport.resize.mockImplementation(actual.resizeChatAttachmentImage);
  return { ...actual, resizeChatAttachmentImage: imageImport.resize };
});

it("cancels an admitted PNG while its preparation module is still loading", async () => {
  const readAsDataURL = vi.fn();
  class Reader extends EventTarget {
    result = null;
    abort() {}
    readAsDataURL = readAsDataURL;
  }
  const worker = vi.fn();
  vi.stubGlobal("FileReader", Reader);
  vi.stubGlobal("Worker", worker);
  onTestFinished(() => {
    imageImport.release.resolve();
    vi.unstubAllGlobals();
  });
  const reads = new ChatAttachmentReadLifecycle(() => {});
  const signal = reads.readSignal;
  const pending = vi.fn((delta: 1 | -1) => reads.updatePending(signal, delta));
  const destination = {
    getAttachments: () => [],
    onAttachmentsChange: vi.fn(),
    onPendingReadsChange: pending,
  };
  const file = new File(["oversized"], "large.png", { type: "image/png" });
  const [entry] = reads.begin([file], [], destination);
  readChatAttachmentFile(file, entry!, reads, {
    attachmentLimits: { maxBytes: 16, maxImageBytes: 4, maxBatchBytes: 16 },
  });
  await imageImport.started.promise;
  expect(reads.pendingReads).toBe(1);
  expect(pending.mock.calls).toEqual([[1]]);

  reads.abortReads();
  imageImport.release.resolve();
  await vi.waitFor(() => expect(imageImport.resize).toHaveBeenCalledOnce());
  expect(imageImport.resize.mock.calls[0]?.[2].aborted).toBe(true);
  expect(reads.pendingReads).toBe(0);
  expect(pending.mock.calls).toEqual([[1], [-1]]);
  expect(worker).not.toHaveBeenCalled();
  expect(readAsDataURL).not.toHaveBeenCalled();
  expect(destination.onAttachmentsChange).not.toHaveBeenCalled();
});
