import { request } from "undici";
import { TargetAuthorizationError } from "../domain/errors.js";
import { assertPublicAddress } from "./network-guard.js";
import { assertUrlWithinAuthorizedTarget, type TargetScope } from "./url-scope.js";

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  maxRedirects?: number;
}

export interface SafeFetchResult {
  statusCode: number;
  body: string;
  finalUrl: string;
}

/**
 * Fetches a URL that must stay within an authorized TargetEnvironment's
 * scope for the entire request, including every redirect hop. Redirects are
 * followed manually (never delegated to the HTTP client) so each hop is
 * re-validated for authority/scope and re-resolved for private/reserved
 * addresses — closing both the "redirect to an unauthorized host" and the
 * "DNS rebinds between check and connect" gaps.
 */
export async function fetchWithinAuthorizedTarget(
  url: string,
  target: TargetScope,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const method = options.method ?? "GET";
  const maxRedirects = options.maxRedirects ?? 5;
  let currentUrl = url;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    assertUrlWithinAuthorizedTarget(currentUrl, method, target);
    const parsed = new URL(currentUrl);
    await assertPublicAddress(parsed.hostname);

    const response = await request(currentUrl, {
      method: method as import("undici").Dispatcher.HttpMethod,
      headers: options.headers,
      maxRedirections: 0,
    });

    if (response.statusCode >= 300 && response.statusCode < 400) {
      const location = response.headers.location;
      const locationHeader = Array.isArray(location) ? location[0] : location;
      if (!locationHeader) {
        throw new TargetAuthorizationError(`Redirect from ${currentUrl} had no Location header`);
      }
      await response.body.dump();
      currentUrl = new URL(locationHeader, currentUrl).toString();
      continue;
    }

    const body = await response.body.text();
    return { statusCode: response.statusCode, body, finalUrl: currentUrl };
  }

  throw new TargetAuthorizationError(`Exceeded maximum redirect hops (${maxRedirects}) while fetching ${url}`);
}
