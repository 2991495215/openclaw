// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayRetryOwner } from "./gateway-retry.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("gateway retry owner", () => {
  it("honors the server minimum without accelerating the normal backoff", () => {
    vi.useFakeTimers();
    const owner = createGatewayRetryOwner();
    const retry = vi.fn();
    owner.schedule(retry, 600_000);
    vi.advanceTimersByTime(599_999);
    expect(retry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(retry).toHaveBeenCalledOnce();
    owner.schedule(retry);
    vi.advanceTimersByTime(59_999);
    expect(retry).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(retry).toHaveBeenCalledTimes(2);
    owner.schedule(retry, Number.MAX_SAFE_INTEGER);
    vi.advanceTimersByTime(600_000);
    expect(retry).toHaveBeenCalledTimes(2);
    owner.cancel();
  });

  it("resumes the same deadline once without advancing backoff, and retires cancelled work", () => {
    vi.useFakeTimers();
    const owner = createGatewayRetryOwner();
    const retry = vi.fn();
    owner.schedule(retry, 90_000);
    vi.advanceTimersByTime(10_000);
    owner.pause();
    expect(owner.hasPending()).toBe(true);
    vi.advanceTimersByTime(20_000);
    expect(owner.resume()).toBe(true);
    expect(owner.resume()).toBe(true);
    vi.advanceTimersByTime(59_999);
    expect(retry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(retry).toHaveBeenCalledOnce();
    expect(owner.hasPending()).toBe(false);
    expect(owner.resume()).toBe(false);
    owner.schedule(retry);
    vi.advanceTimersByTime(59_999);
    expect(retry).toHaveBeenCalledOnce();
    owner.pause();
    vi.advanceTimersByTime(10_000);
    expect(retry).toHaveBeenCalledOnce();
    owner.resume();
    vi.advanceTimersByTime(0);
    expect(retry).toHaveBeenCalledTimes(2);
    owner.schedule(retry);
    owner.pause();
    owner.cancel();
    expect(owner.hasPending()).toBe(false);
    expect(owner.resume()).toBe(false);
    vi.advanceTimersByTime(300_000);
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it("backs off from 30 seconds and caps retries at five minutes", () => {
    vi.useFakeTimers();
    const owner = createGatewayRetryOwner();
    const retry = vi.fn();

    for (const delayMs of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
      const completed = retry.mock.calls.length;
      owner.schedule(retry);
      vi.advanceTimersByTime(delayMs - 1);
      expect(retry).toHaveBeenCalledTimes(completed);
      vi.advanceTimersByTime(1);
      expect(retry).toHaveBeenCalledTimes(completed + 1);
    }
  });

  it("cancels stale timers without resetting the current backoff", () => {
    vi.useFakeTimers();
    const owner = createGatewayRetryOwner();
    const staleRetry = vi.fn();
    const currentRetry = vi.fn();

    owner.schedule(staleRetry);
    owner.cancel();
    expect(vi.getTimerCount()).toBe(0);

    owner.schedule(currentRetry);
    vi.advanceTimersByTime(59_999);
    expect(staleRetry).not.toHaveBeenCalled();
    expect(currentRetry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(currentRetry).toHaveBeenCalledOnce();
  });

  it("resets active timers and restarts the initial delay", () => {
    vi.useFakeTimers();
    const owner = createGatewayRetryOwner();
    const staleRetry = vi.fn();
    const currentRetry = vi.fn();

    owner.schedule(staleRetry);
    vi.advanceTimersByTime(10_000);
    owner.reset();
    expect(vi.getTimerCount()).toBe(0);

    owner.schedule(currentRetry);
    vi.advanceTimersByTime(29_999);
    expect(staleRetry).not.toHaveBeenCalled();
    expect(currentRetry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(currentRetry).toHaveBeenCalledOnce();
  });
});
