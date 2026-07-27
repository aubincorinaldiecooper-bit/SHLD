import { describe, expect, it } from "vitest";
import { StateMachine } from "../../src/domain/state-machine.js";
import { InvalidStateTransitionError } from "../../src/domain/errors.js";
import { runStateMachine } from "../../src/domain/run-state-machine.js";
import { findingStateMachine } from "../../src/domain/finding-state-machine.js";

type Light = "red" | "yellow" | "green";

describe("StateMachine (generic)", () => {
  const sm = new StateMachine<Light>("TrafficLight", {
    red: ["green"],
    green: ["yellow"],
    yellow: ["red"],
  });

  it("allows a legal transition", () => {
    expect(sm.canTransition("red", "green")).toBe(true);
  });

  it("rejects an illegal transition", () => {
    expect(sm.canTransition("red", "yellow")).toBe(false);
  });

  it("throws a typed error on assertTransition for illegal moves", () => {
    expect(() => sm.assertTransition("red", "yellow")).toThrow(InvalidStateTransitionError);
  });

  it("does not throw for legal moves", () => {
    expect(() => sm.assertTransition("green", "yellow")).not.toThrow();
  });

  it("reports allowed next states", () => {
    expect(sm.allowedNext("red")).toEqual(["green"]);
  });
});

describe("runStateMachine", () => {
  it("follows the change-review happy path", () => {
    const path: Array<[Parameters<typeof runStateMachine.canTransition>[0], Parameters<typeof runStateMachine.canTransition>[1]]> = [
      ["queued", "classifying"],
      ["classifying", "source_review_running"],
      ["source_review_running", "source_review_completed"],
      ["source_review_completed", "validation_running"],
      ["validation_running", "blocked"],
    ];
    for (const [from, to] of path) {
      expect(runStateMachine.canTransition(from, to)).toBe(true);
    }
  });

  it("allows a fix_verification run to resolve blocked -> completed via a new run", () => {
    expect(runStateMachine.canTransition("queued", "classifying")).toBe(true);
    expect(runStateMachine.canTransition("fix_verification_running", "completed")).toBe(true);
    expect(runStateMachine.canTransition("fix_verification_running", "blocked")).toBe(true);
  });

  it("rejects skipping straight from queued to completed", () => {
    expect(runStateMachine.canTransition("queued", "completed")).toBe(false);
  });

  it("rejects transitions out of terminal states", () => {
    expect(runStateMachine.allowedNext("completed")).toEqual([]);
    expect(runStateMachine.allowedNext("blocked")).toEqual([]);
    expect(runStateMachine.canTransition("blocked", "completed")).toBe(false);
  });
});

describe("findingStateMachine", () => {
  it("follows the spec's worked example path", () => {
    expect(findingStateMachine.canTransition("suspected", "source_confirmed")).toBe(true);
    expect(findingStateMachine.canTransition("source_confirmed", "validation_queued")).toBe(true);
    expect(findingStateMachine.canTransition("validation_queued", "confirmed")).toBe(true);
    expect(findingStateMachine.canTransition("confirmed", "fix_pending")).toBe(true);
    expect(findingStateMachine.canTransition("fix_pending", "fix_submitted")).toBe(true);
    expect(findingStateMachine.canTransition("fix_submitted", "retesting")).toBe(true);
    expect(findingStateMachine.canTransition("retesting", "verified_fixed")).toBe(true);
  });

  it("allows still_exploitable to loop back to fix_pending", () => {
    expect(findingStateMachine.canTransition("retesting", "still_exploitable")).toBe(true);
    expect(findingStateMachine.canTransition("still_exploitable", "fix_pending")).toBe(true);
  });

  it("rejects jumping straight from suspected to confirmed", () => {
    expect(findingStateMachine.canTransition("suspected", "confirmed")).toBe(false);
  });

  it("rejects transitions out of verified_fixed", () => {
    expect(findingStateMachine.allowedNext("verified_fixed")).toEqual([]);
  });
});
