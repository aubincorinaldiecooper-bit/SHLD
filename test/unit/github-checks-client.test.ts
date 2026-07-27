import { describe, expect, it } from "vitest";
import { mapRunStatusToCheckRun, type GitHubChecksClient } from "../../src/github/checks-client.js";

describe("mapRunStatusToCheckRun", () => {
  it("maps queued and classifying to the queued check phase", () => {
    expect(mapRunStatusToCheckRun("queued").title).toBe("Security review queued");
    expect(mapRunStatusToCheckRun("classifying").status).toBe("queued");
  });

  it("maps each in-progress run status to its own titled phase", () => {
    expect(mapRunStatusToCheckRun("source_review_running").title).toBe("Source review running");
    expect(mapRunStatusToCheckRun("source_review_completed").title).toBe("Source review completed");
    expect(mapRunStatusToCheckRun("validation_waiting_for_target").title).toBe(
      "Runtime validation waiting for preview",
    );
    expect(mapRunStatusToCheckRun("validation_running").title).toBe("Runtime validation running");
  });

  it("maps completed to Passed with a success conclusion", () => {
    const update = mapRunStatusToCheckRun("completed");
    expect(update).toMatchObject({ status: "completed", conclusion: "success", title: "Passed" });
  });

  it("maps completed + inconclusive receipt to Inconclusive with a neutral conclusion", () => {
    const update = mapRunStatusToCheckRun("completed", "inconclusive");
    expect(update).toMatchObject({ status: "completed", conclusion: "neutral", title: "Inconclusive" });
  });

  it("maps blocked and failed to a failure conclusion", () => {
    expect(mapRunStatusToCheckRun("blocked")).toMatchObject({ conclusion: "failure", title: "Blocked" });
    expect(mapRunStatusToCheckRun("failed")).toMatchObject({ conclusion: "failure", title: "Failed" });
  });

  it("maps awaiting_fix to action_required", () => {
    expect(mapRunStatusToCheckRun("awaiting_fix")).toMatchObject({
      status: "completed",
      conclusion: "action_required",
      title: "Fix verification required",
    });
  });

  it("maps cancelled to a cancelled conclusion", () => {
    expect(mapRunStatusToCheckRun("cancelled")).toMatchObject({ status: "completed", conclusion: "cancelled" });
  });
});

describe("GitHubChecksClient interface", () => {
  it("a conforming mock implementation can be constructed and called", async () => {
    const calls: unknown[] = [];
    const client: GitHubChecksClient = {
      async upsertCheckRun(params) {
        calls.push(params);
      },
    };
    await client.upsertCheckRun({
      owner: "acme",
      repo: "widgets",
      headSha: "b".repeat(40),
      runId: "run_1",
      runStatus: "blocked",
      detailsUrl: "https://shld.example.com/runs/run_1",
    });
    expect(calls).toHaveLength(1);
  });
});
