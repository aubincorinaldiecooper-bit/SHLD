import { createSign } from "node:crypto";

export interface GitHubAppJwtParams {
  appId: string;
  privateKeyPem: string;
  /** Clock skew allowance, in seconds. */
  now?: () => number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Signs a GitHub App JWT (RS256, per GitHub's App authentication flow) —
 * used to exchange for a short-lived installation access token before any
 * GitHub API call. Pure crypto, no network access.
 */
export function createGitHubAppJwt(params: GitHubAppJwtParams): string {
  const now = Math.floor((params.now ?? Date.now)() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60, // allow for clock drift
    exp: now + 9 * 60, // GitHub caps this at 10 minutes
    iss: params.appId,
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = createSign("RSA-SHA256").update(signingInput).sign(params.privateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}

export interface InstallationTokenFetcher {
  (installationId: number): Promise<{ token: string; expiresAt: Date }>;
}

/**
 * Exchanges the App JWT for an installation access token via GitHub's
 * REST API. Real network call — not exercised by tests in this
 * environment (no live GitHub App credentials here); the JWT signing
 * above is unit tested in isolation.
 */
export function createInstallationTokenFetcher(params: GitHubAppJwtParams): InstallationTokenFetcher {
  return async (installationId: number) => {
    const jwt = createGitHubAppJwt(params);
    const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to exchange GitHub App JWT for an installation token: ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as { token: string; expires_at: string };
    return { token: body.token, expiresAt: new Date(body.expires_at) };
  };
}
