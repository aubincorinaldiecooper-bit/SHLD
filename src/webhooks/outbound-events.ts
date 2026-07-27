export type OutboundWebhookEventType =
  | "security.run.started"
  | "security.run.completed"
  | "security.run.failed"
  | "security.finding.created"
  | "security.finding.confirmed"
  | "security.finding.fix_required"
  | "security.finding.verified_fixed"
  | "security.review.blocked";
