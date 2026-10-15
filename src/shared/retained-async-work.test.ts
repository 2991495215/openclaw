import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createDeferredCore } from "./deferred.js";
import { RetainedAsyncWork } from "./retained-async-work.js";

describe("retained async work", () => {
  it("only the last owner closes admission and joins accepted work", async () => {
    const work = new RetainedAsyncWork();
    const first = work.retain();
    const second = work.retain();
    const finish = createDeferredCore();
    const accepted = work.scope.track(() => finish.promise);
    await first.drain();
    expect(work.isClosing).toBe(false);
    let drained = false;
    const closing = second.drain().then(() => {
      drained = true;
    });
    try {
      await nextTurn();
      expect(work.isClosing).toBe(true);
      expect(drained).toBe(false);
      first.beginClose();
      expect(work.hasOwners).toBe(false);
    } finally {
      finish.resolve();
      await Promise.all([accepted, closing]);
    }
    expect(drained).toBe(true);
  });

  it("a successor gets a fresh phase while disposal still joins prior work", async () => {
    const work = new RetainedAsyncWork();
    const first = work.retain();
    const oldScope = work.scope;
    const finishOld = createDeferredCore();
    const oldWork = oldScope.track(() => finishOld.promise);
    first.beginClose();
    const successor = work.retain();
    expect(work.scope).not.toBe(oldScope);
    const finishNew = createDeferredCore();
    const newWork = work.scope.track(() => finishNew.promise);
    let disposed = false;
    const disposal = work.close().then(() => {
      disposed = true;
    });
    try {
      finishNew.resolve();
      await newWork;
      await nextTurn();
      expect(disposed).toBe(false);
    } finally {
      finishOld.resolve();
      await Promise.all([oldWork, first.drain(), disposal, successor.drain()]);
    }
    expect(disposed).toBe(true);
  });

  it("retains failed cleanup so later disposal still reports the failure", async () => {
    const failure = new Error("cleanup remains unsettled");
    const work = new RetainedAsyncWork(() => {
      throw failure;
    });
    const owner = work.retain();
    await expect(owner.drain()).rejects.toBe(failure);
    await expect(work.close()).rejects.toBe(failure);
  });
});
