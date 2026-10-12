/**
 * Runtime SDK subpath for building approval replies and exec approval presentations.
 */
export {
  // Shipped Plugin SDK compatibility alias; remove in a later normal release after stable deprecation and a compatibility period.
  buildApprovalButtonPresentation as buildApprovalPresentation,
  buildApprovalPresentationFromActionDescriptors,
  buildExecApprovalPresentation,
  buildExecApprovalActionDescriptors,
  buildExecApprovalPendingReplyPayload,
  formatExecApprovalExpiresIn,
  buildTypedApprovalPresentation,
  buildTypedExecApprovalPendingReplyPayload,
  getExecApprovalApproverDmNoticeText,
  getExecApprovalReplyMetadata,
  parseExecApprovalCommandText,
  type ExecApprovalActionDescriptor,
  type ExecApprovalPendingReplyParams,
  type ExecApprovalReplyDecision,
  type ExecApprovalReplyMetadata,
} from "../infra/exec-approval-reply.js";
export { resolveExecApprovalCommandDisplay } from "../infra/exec-approval-command-display.js";
export {
  resolveExecApprovalAllowedDecisions,
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalDecision,
} from "../infra/exec-approvals.js";
export {
  buildPluginApprovalPendingReplyPayload,
  buildTypedPluginApprovalPendingReplyPayload,
} from "./approval-renderers.js";
