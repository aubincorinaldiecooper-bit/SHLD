import type { FindingStatus } from "@prisma/client";
import { StateMachine, type TransitionTable } from "./state-machine.js";

/**
 * Finding.status transitions, derived directly from the worked examples in
 * the spec:
 *   DeepSec finding created            -> suspected
 *   DeepSec revalidation: true positive -> source_confirmed
 *   Policy requires runtime testing    -> validation_queued
 *   Strix confirms the exploit         -> confirmed
 *   Strix cannot reproduce             -> not_reproduced | inconclusive
 *   Fix commit attached                -> fix_submitted
 *   Verification begins                -> retesting
 *   All required checks pass           -> verified_fixed
 *   Exploit still succeeds             -> still_exploitable
 *
 * `dismissed` and `accepted_risk` are human/policy overrides reachable from
 * any non-terminal investigative state. `fix_pending` is the queue state
 * between "a fix is owed" and "a fix commit was attached".
 */
const FINDING_TRANSITIONS: TransitionTable<FindingStatus> = {
  suspected: ["source_confirmed", "dismissed", "not_reproduced"],
  source_confirmed: ["validation_queued", "fix_pending", "dismissed", "accepted_risk"],
  validation_queued: ["confirmed", "not_reproduced", "inconclusive"],
  confirmed: ["fix_pending", "accepted_risk"],
  not_reproduced: ["dismissed", "accepted_risk", "fix_pending", "validation_queued"],
  inconclusive: ["validation_queued", "dismissed", "accepted_risk", "fix_pending"],
  fix_pending: ["fix_submitted", "accepted_risk", "dismissed"],
  fix_submitted: ["retesting"],
  retesting: ["verified_fixed", "still_exploitable", "inconclusive"],
  still_exploitable: ["fix_pending"],
  verified_fixed: [],
  accepted_risk: [],
  dismissed: [],
};

export const findingStateMachine = new StateMachine<FindingStatus>("Finding", FINDING_TRANSITIONS);

export function isFindingTerminal(status: FindingStatus): boolean {
  return findingStateMachine.allowedNext(status).length === 0;
}
