import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const SESSION_OBSERVER_HEALTH_VALUES = [
  "on-track",
  "grinding",
  "stuck",
  "waiting-on-user",
  "wrapping-up",
  "done",
  "failed",
] as const;

/** Trajectory judgment produced for one observed agent session. */
export const SessionObserverHealthSchema = Type.Union([
  Type.Literal("on-track"),
  Type.Literal("grinding"),
  Type.Literal("stuck"),
  Type.Literal("waiting-on-user"),
  Type.Literal("wrapping-up"),
  Type.Literal("done"),
  Type.Literal("failed"),
]);

export const SessionObserverPlanProgressSchema = closedObject({
  completed: Type.Integer({ minimum: 0 }),
  total: Type.Integer({ minimum: 0 }),
});

/** Live session status judgment broadcast to subscribed operator clients. */
export const SessionObserverDigestSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  sessionId: Type.Optional(NonEmptyString),
  lifecycleRevision: Type.Optional(NonEmptyString),
  runId: Type.Optional(NonEmptyString),
  revision: Type.Integer({ minimum: 1 }),
  updatedAt: Type.Integer({ minimum: 0 }),
  headline: Type.String({ minLength: 1, maxLength: 120 }),
  assessment: Type.Optional(Type.String({ minLength: 1, maxLength: 320 })),
  health: SessionObserverHealthSchema,
  planProgress: Type.Optional(SessionObserverPlanProgressSchema),
});
