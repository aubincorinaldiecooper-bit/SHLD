import { TargetAuthorizationError } from "../domain/errors.js";

export interface TargetScope {
  baseUrl: string;
  allowedPaths: string[];
  excludedPaths: string[];
}

interface ScopePattern {
  method: string; // "*" or an uppercase HTTP method
  pathRegex: RegExp;
}

const HTTP_METHODS = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/i;

function parseScopePattern(pattern: string): ScopePattern {
  const trimmed = pattern.trim();
  const methodMatch = trimmed.match(HTTP_METHODS);
  const method = methodMatch ? methodMatch[1]!.toUpperCase() : "*";
  const pathPattern = methodMatch ? methodMatch[2]! : trimmed;
  // Escape regex metacharacters, then reintroduce `*` as a wildcard.
  const escaped = pathPattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return { method, pathRegex: new RegExp(`^${escaped}$`) };
}

function matchesScope(patterns: string[], method: string, pathname: string): boolean {
  return patterns.some((pattern) => {
    const parsed = parseScopePattern(pattern);
    return (parsed.method === "*" || parsed.method === method.toUpperCase()) && parsed.pathRegex.test(pathname);
  });
}

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
}

/** Exact scheme + hostname + port match — never a prefix/substring check. */
export function matchesAuthority(url: URL, base: URL): boolean {
  const urlPort = url.port || defaultPort(url.protocol);
  const basePort = base.port || defaultPort(base.protocol);
  return url.protocol === base.protocol && url.hostname === base.hostname && urlPort === basePort;
}

/**
 * Validates a candidate URL against a TargetEnvironment's authorized scope.
 * Uses the WHATWG URL parser for both sides so userinfo/host tricks
 * (`https://authorized.com@evil.com`) and lookalike-suffix tricks
 * (`https://authorized.com.evil.com`) are rejected by construction — the
 * comparison is always on the parsed `hostname`, never a string prefix.
 */
export function assertUrlWithinAuthorizedTarget(rawUrl: string, method: string, target: TargetScope): void {
  let url: URL;
  let base: URL;
  try {
    url = new URL(rawUrl);
    base = new URL(target.baseUrl);
  } catch {
    throw new TargetAuthorizationError(`Malformed URL: ${rawUrl}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TargetAuthorizationError(`Unsupported protocol: ${url.protocol}`);
  }

  if (!matchesAuthority(url, base)) {
    throw new TargetAuthorizationError(`URL ${rawUrl} does not match the authorized target host ${target.baseUrl}`);
  }

  if (target.excludedPaths.length > 0 && matchesScope(target.excludedPaths, method, url.pathname)) {
    throw new TargetAuthorizationError(`Path ${url.pathname} is explicitly excluded from the authorized scope`);
  }

  if (target.allowedPaths.length > 0 && !matchesScope(target.allowedPaths, method, url.pathname)) {
    throw new TargetAuthorizationError(`Path ${url.pathname} is outside the authorized scope`);
  }
}
