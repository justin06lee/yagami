import { ApiError } from "./types.js";

/** Base class for typed yagami failures — every subclass carries a stable `code`. */
export class YagamiError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "YagamiError";
  }
}

/** The provider's CLI could not be found on this machine. */
export class ProviderNotInstalledError extends YagamiError {
  constructor(
    readonly provider: string,
    readonly installHint: string,
    detail?: string,
  ) {
    super(
      `${provider}: CLI not found${detail ? ` (${detail})` : ""}. ${installHint}`,
      "provider_not_installed",
    );
    this.name = "ProviderNotInstalledError";
  }
}

/** The provider's CLI is installed but not logged in (or its login expired). */
export class AuthRequiredError extends YagamiError {
  constructor(
    readonly provider: string,
    readonly loginCommand: string,
    detail?: string,
  ) {
    super(
      `${provider}: not logged in${detail ? ` (${detail})` : ""}. Run: ${loginCommand}`,
      "auth_required",
    );
    this.name = "AuthRequiredError";
  }
}

/** The provider ran but failed — process crash, protocol error, engine error. */
export class ProviderError extends YagamiError {
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(`${provider}: ${message}`, "provider_error");
    this.name = "ProviderError";
  }
}

/** Result of comparing an SDK build against the CLI binary it drives. */
export interface VersionSkew {
  sdkVersion: string;
  binaryVersion: string;
  inSync: boolean;
  note: string;
}

const AUTH_PATTERNS: RegExp[] = [
  /not logged in/i,
  /login required/i,
  /please (run|use) [`'"]?\/?login/i,
  /invalid api key/i,
  /authentication[_ ]error/i,
  /auth(entication)? required/i,
  /not authenticated/i,
  /unauthorized/i,
  /credentials? (are|is) (missing|invalid|expired)/i,
  /token (has )?expired/i,
  /no credentials/i,
];

/** Does this error text look like a sign-in problem rather than a crash? */
export function looksLikeAuthFailure(text: string): boolean {
  return AUTH_PATTERNS.some((re) => re.test(text));
}

/**
 * Normalize any thrown value into a typed yagami error for `provider`,
 * recognizing sign-in failures by message.
 */
export function classifyProviderFailure(provider: string, loginCommand: string, err: unknown): YagamiError {
  if (err instanceof YagamiError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (looksLikeAuthFailure(message)) {
    return new AuthRequiredError(provider, loginCommand, message.split("\n")[0]?.slice(0, 200));
  }
  return new ProviderError(provider, message);
}

/** Map any failure onto the Anthropic-shaped HTTP error the API returns. */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof AuthRequiredError || err instanceof ProviderNotInstalledError) {
    return new ApiError(503, "api_error", err.message);
  }
  if (err instanceof YagamiError) return new ApiError(500, "api_error", err.message);
  const message = err instanceof Error ? err.message : String(err);
  return new ApiError(500, "api_error", `engine error: ${message}`);
}
