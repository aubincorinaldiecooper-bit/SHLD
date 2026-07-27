import type { SecurityRunStatus } from "@prisma/client";
import { StateMachine, type TransitionTable } from "./state-machine.js";

/**
 * SecurityRun.status mixes operational-progress states (queued ..
 * fix_verification_running) with dispositional terminal states (completed,
 * blocked, awaiting_fix, failed, cancelled).
 *
 * Design decision (not fully pinned down by the spec, documented here):
 *  - `blocked` is reached when the run concludes with a *runtime-confirmed*
 *    exploitable finding (Strix confirmed, or a prior confirmed finding
 *    reappears). This is a hard gate.
 *  - `awaiting_fix` is reached when the run concludes with a
 *    *source-confirmed-only* finding that still requires a fix but was
 *    never runtime-confirmed (no validation required, or validation came
 *    back not_reproduced/inconclusive while policy still wants a fix). This
 *    is a softer gate.
 *  - `completed` is reached when there is no unresolved finding blocking the
 *    change (no findings, or all findings dismissed/accepted_risk/
 *    verified_fixed).
 *  - A fix_verification run resolves to completed (verified_fixed),
 *    blocked (still_exploitable), awaiting_fix (partially_fixed /
 *    inconclusive — another fix attempt is needed), or failed
 *    (verification_failed / operational error).
 */
const RUN_TRANSITIONS: TransitionTable<SecurityRunStatus> = {
  queued: ["classifying", "failed", "cancelled"],
  classifying: ["source_review_running", "failed", "cancelled"],
  source_review_running: ["source_review_completed", "failed", "cancelled"],
  source_review_completed: [
    "validation_waiting_for_target",
    "validation_running",
    "awaiting_fix",
    "blocked",
    "completed",
    "failed",
    "cancelled",
  ],
  validation_waiting_for_target: ["validation_running", "failed", "cancelled"],
  validation_running: ["awaiting_fix", "blocked", "completed", "failed", "cancelled"],
  awaiting_fix: ["fix_verification_running", "cancelled"],
  fix_verification_running: ["completed", "blocked", "awaiting_fix", "failed", "cancelled"],
  completed: [],
  blocked: [],
  failed: [],
  cancelled: [],
};

export const runStateMachine = new StateMachine<SecurityRunStatus>("SecurityRun", RUN_TRANSITIONS);

export function isRunTerminal(status: SecurityRunStatus): boolean {
  return runStateMachine.allowedNext(status).length === 0;
}
