import {
  type WebClient as SlackWebClient,
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
} from "@slack/web-api";
import { readExpiringMapEntry, writeLruMapEntry } from "openclaw/plugin-sdk/collection-runtime";
import {
  collectErrorGraphCandidates,
  extractErrorCode,
  readErrorName,
} from "openclaw/plugin-sdk/error-runtime";
import { classifyTransientNetworkErrorCode } from "openclaw/plugin-sdk/retry-runtime";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString as normalizeThreadTs } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatSlackError } from "../errors.js";
import type { SlackMessageEvent } from "../types.js";
import type { SlackIngressTurnLifecycle } from "./ingress.types.js";

type ThreadTsCacheEntry = {
  threadTs: string | null;
  expiresAt: number;
};

const DEFAULT_THREAD_TS_CACHE_TTL_MS = 60_000;
const DEFAULT_THREAD_TS_CACHE_MAX = 500;

const markAmbiguousThreadReply = (message: SlackMessageEvent): SlackMessageEvent => ({
  ...message,
  _ambiguousThreadReply: true,
});

export function isTransientSlackThreadLookupError(error: unknown): boolean {
  if (error instanceof WebAPIRateLimitedError) {
    return true;
  }
  if (error instanceof WebAPIHTTPError) {
    return (
      error.statusCode === 408 ||
      error.statusCode === 429 ||
      (error.statusCode >= 500 && error.statusCode < 600)
    );
  }
  // Slack documents these users.info response codes as transient service failures.
  if (error instanceof WebAPIPlatformError) {
    return error.data.error === "internal_error" || error.data.error === "service_unavailable";
  }
  if (!(error instanceof WebAPIRequestError)) {
    return false;
  }
  // Slack Web API 8.0.0 wraps exhausted 429 retries as this uncoded request error.
  if (/^A rate limit was exceeded \(url: .+, retry-after: \d+\)$/.test(error.original.message)) {
    return true;
  }
  return collectErrorGraphCandidates(error.original, (current) => [
    current.cause,
    current.error,
    current.original,
  ]).some(
    (candidate) =>
      classifyTransientNetworkErrorCode(extractErrorCode(candidate)) ||
      readErrorName(candidate) === "TimeoutError",
  );
}

async function resolveThreadTsFromHistory(params: {
  client: SlackWebClient;
  channelId: string;
  messageTs: string;
}) {
  const response = await params.client.conversations.history({
    channel: params.channelId,
    latest: params.messageTs,
    oldest: params.messageTs,
    inclusive: true,
    limit: 1,
  });
  const message =
    response.messages?.find((entry) => entry.ts === params.messageTs) ?? response.messages?.[0];
  return normalizeThreadTs(message?.thread_ts);
}

export function createSlackThreadTsResolver(params: { client: SlackWebClient }) {
  const cache = new Map<string, ThreadTsCacheEntry>();
  const inflight = new Map<string, Promise<string | undefined>>();

  return {
    resolve: async (request: {
      message: SlackMessageEvent;
      source: "message" | "app_mention";
      turnAdoptionLifecycle?: SlackIngressTurnLifecycle;
    }): Promise<SlackMessageEvent> => {
      const { message } = request;
      if (!message.parent_user_id || message.thread_ts || !message.ts) {
        return message;
      }

      const cacheKey = `${message.channel}:${message.ts}`;
      const now = Date.now();
      const cached = readExpiringMapEntry(cache, cacheKey, now);
      if (cached) {
        cache.delete(cacheKey);
        cache.set(cacheKey, cached);
        return cached.threadTs
          ? { ...message, thread_ts: cached.threadTs }
          : markAmbiguousThreadReply(message);
      }

      if (shouldLogVerbose()) {
        logVerbose(
          `slack inbound: missing thread_ts for thread reply channel=${message.channel} ts=${message.ts} source=${request.source}`,
        );
      }

      let pending = inflight.get(cacheKey);
      if (!pending) {
        pending = resolveThreadTsFromHistory({
          client: params.client,
          channelId: message.channel,
          messageTs: message.ts,
        });
        inflight.set(cacheKey, pending);
      }

      let resolved: string | undefined;
      try {
        resolved = await pending;
      } catch (err) {
        if (shouldLogVerbose()) {
          logVerbose(
            `slack inbound: failed to resolve thread_ts via conversations.history for channel=${message.channel} ts=${message.ts}: ${formatSlackError(err)}`,
          );
        }
        if (isTransientSlackThreadLookupError(err)) {
          if (request.turnAdoptionLifecycle) {
            // The already-acknowledged durable ingress owner retries without dropping the turn.
            throw err;
          }
          return markAmbiguousThreadReply(message);
        }
      } finally {
        inflight.delete(cacheKey);
      }

      writeLruMapEntry(
        cache,
        cacheKey,
        { threadTs: resolved ?? null, expiresAt: Date.now() + DEFAULT_THREAD_TS_CACHE_TTL_MS },
        DEFAULT_THREAD_TS_CACHE_MAX,
      );

      if (resolved) {
        if (shouldLogVerbose()) {
          logVerbose(
            `slack inbound: resolved missing thread_ts channel=${message.channel} ts=${message.ts} -> thread_ts=${resolved}`,
          );
        }
        return { ...message, thread_ts: resolved };
      }

      if (shouldLogVerbose()) {
        logVerbose(
          `slack inbound: could not resolve missing thread_ts channel=${message.channel} ts=${message.ts}; marking reply ambiguous`,
        );
      }
      return markAmbiguousThreadReply(message);
    },
  };
}
