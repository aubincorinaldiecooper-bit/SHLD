import { generateKeyPairSync, createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGitHubAppJwt } from "../../src/github/app-auth.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function decodePayload(jwt: string): Record<string, unknown> {
  const [, payload] = jwt.split(".");
  return JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
}

describe("createGitHubAppJwt", () => {
  it("produces a three-segment JWT with a valid RS256 signature", () => {
    const jwt = createGitHubAppJwt({ appId: "12345", privateKeyPem: privateKey });
    const segments = jwt.split(".");
    expect(segments).toHaveLength(3);

    const [encodedHeader, encodedPayload, encodedSignature] = segments;
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${encodedHeader}.${encodedPayload}`);
    expect(verifier.verify(publicKey, Buffer.from(encodedSignature!, "base64url"))).toBe(true);
  });

  it("sets iss to the app id and an expiry within GitHub's 10-minute cap", () => {
    const nowSeconds = 1_700_000_000;
    const jwt = createGitHubAppJwt({ appId: "999", privateKeyPem: privateKey, now: () => nowSeconds * 1000 });
    const payload = decodePayload(jwt);
    expect(payload.iss).toBe("999");
    expect(payload.iat).toBeLessThanOrEqual(nowSeconds);
    expect((payload.exp as number) - (payload.iat as number)).toBeLessThanOrEqual(600);
  });

  it("backdates iat slightly to tolerate clock drift", () => {
    const nowSeconds = 1_700_000_000;
    const jwt = createGitHubAppJwt({ appId: "999", privateKeyPem: privateKey, now: () => nowSeconds * 1000 });
    const payload = decodePayload(jwt);
    expect(payload.iat).toBe(nowSeconds - 60);
  });
});
