import type { StrixMission } from "./types.js";

/**
 * Renders the focused instruction file handed to the Strix sandbox. Shape
 * mirrors the spec's worked example exactly: hypothesis, source location,
 * authorized target, allowed scope, approved accounts, and explicit
 * restrictions/stop condition — never a broad "go pentest this app" brief.
 */
export function buildStrixInstruction(mission: StrixMission): string {
  const lines: string[] = [];

  lines.push(`Validate finding ${mission.findingId}.`, "");
  lines.push("Hypothesis:", mission.hypothesis, "");
  lines.push("Source:", `${mission.sourceFile}${mission.sourceLines ? `, lines ${mission.sourceLines}` : ""}.`, "");
  lines.push("Target:", mission.targetBaseUrl, "");
  lines.push("Allowed scope:", ...mission.allowedScope, "");

  if (mission.excludedPaths.length > 0) {
    lines.push("Excluded paths:", ...mission.excludedPaths, "");
  }

  if (mission.testAccounts.length > 0) {
    const labels = mission.testAccounts.map((a) => a.label).join(" and ");
    const plural = mission.testAccounts.length > 1 ? "s" : "";
    lines.push(`Use only the supplied ${labels} test account${plural}.`, "");
  }

  lines.push("Do not test unrelated endpoints.");
  lines.push(
    mission.destructiveTestingAllowed
      ? "Destructive actions are permitted only when required to reproduce the hypothesis."
      : "Do not perform destructive actions.",
  );
  lines.push("Do not create persistent data unless required for reproduction.");
  lines.push("Stop after confirming, disproving or exhausting the hypothesis.");
  if (mission.stopCondition) {
    lines.push(mission.stopCondition);
  }

  return lines.join("\n");
}
