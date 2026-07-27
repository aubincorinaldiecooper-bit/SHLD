import { AuthorizationError } from "../domain/errors.js";

/**
 * The minimal shape a caller needs for tenant-scoped reads — both
 * AuthenticatedAgent and AuthenticatedUser satisfy this structurally, so
 * read-only services (getRun, getFinding, ...) can accept either without
 * duplicating query logic per principal type. MCP, the dashboard, and the
 * API all call the same functions.
 */
export interface TenantPrincipal {
  organizationId: string;
}

/** The one gate every service must pass a loaded resource through. */
export function assertSameOrganization(expectedOrgId: string, resourceOrgId: string, context = "resource"): void {
  if (expectedOrgId !== resourceOrgId) {
    throw new AuthorizationError(`Cross-tenant access denied for ${context}`);
  }
}
