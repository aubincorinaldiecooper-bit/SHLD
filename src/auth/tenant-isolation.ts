import { AuthorizationError } from "../domain/errors.js";

/** The one gate every service must pass a loaded resource through. */
export function assertSameOrganization(expectedOrgId: string, resourceOrgId: string, context = "resource"): void {
  if (expectedOrgId !== resourceOrgId) {
    throw new AuthorizationError(`Cross-tenant access denied for ${context}`);
  }
}
