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
    /** HTTP status of the upstream API call that failed, when the harness passes it on (429, 503, …). */
    readonly status?: number,
  ) {
    super(`${provider}: ${message}`, "provider_error");
    this.name = "ProviderError";
  }
}

/** The provider's plan is out of usage until `resetsAt` (epoch seconds, when known). */
export class UsageLimitError extends YagamiError {
  constructor(
    readonly provider: string,
    readonly resetsAt: number | undefined,
    message: string,
    /** HTTP status the harness reported with it, when it did (402, 429). */
    readonly status?: number,
  ) {
    super(`${provider}: ${message}`, "usage_limit");
    this.name = "UsageLimitError";
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
 * A plan that is out of usage, in the words the harnesses use for it. A
 * plain "rate limit" is left out on purpose: that one passes on its own.
 */
const USAGE_LIMIT =
  /\b(?:usage|weekly|daily|monthly|session|5-hour|five-hour) limit\b|\b(?:quota|balance|credits?) (?:is |are )?(?:exceeded|exhausted|depleted|used up)\b|\bexceeded your (?:current )?quota\b|\bout of (?:credits|quota)\b|\binsufficient (?:balance|credits?|quota|funds)\b|\bpayment required\b/i;

/** Does this error text say the plan is used up, rather than that something broke? */
export function looksLikeUsageLimit(text: string): boolean {
  return USAGE_LIMIT.test(text);
}

/** The phrases JSON-RPC gives its error codes: they say which code, not what went wrong. */
const STOCK_PHRASE = /^(?:internal error|invalid params|invalid request|method not found|parse error|server error|unknown error)\.?$/i;

/** A reset time in epoch seconds, from seconds, milliseconds or an ISO date. */
function epochSeconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value > 1e12 ? value / 1000 : value);
  if (typeof value === "string") {
    const at = Date.parse(value);
    if (Number.isFinite(at)) return Math.floor(at / 1000);
  }
  return undefined;
}

/**
 * What a failure says once the reason is dug out of it. A protocol error
 * (JSON-RPC, so every ACP agent) carries a stock phrase as its message and
 * the actual reason in `data`: Grok answers a spent balance with "Internal
 * error" and `{ message: "API error (status 402 Payment Required): …",
 * http_status: 402 }`. Reading only the message loses the one thing a caller
 * needs.
 */
export function describeFailure(err: unknown): { message: string; status?: number; resetsAt?: number } {
  const base = err instanceof Error ? err.message : String(err);
  const data = (err as { data?: unknown } | null | undefined)?.data;
  const fields = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const nested = fields["error"] !== null && typeof fields["error"] === "object" ? (fields["error"] as Record<string, unknown>) : {};
  const said = [data, fields["message"], fields["error"], nested["message"], fields["detail"], fields["details"], fields["reason"], fields["description"]].find(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  let status = [fields["http_status"], fields["httpStatus"], fields["status"], fields["statusCode"], fields["status_code"], nested["status"], nested["code"]].find(
    (value): value is number => typeof value === "number" && value >= 400 && value <= 599,
  );
  let inner = said?.trim();
  if (inner) {
    // "API error (status 402 Payment Required): <reason>" — the status moves to the end
    const wrapped = /^API error \(status (\d{3})[^)]*\):\s*/i.exec(inner);
    if (wrapped) {
      status ??= Number(wrapped[1]);
      inner = inner.slice(wrapped[0].length) || inner;
    }
  }
  let message = !inner ? base : STOCK_PHRASE.test(base.trim()) ? inner : base.includes(inner) ? base : `${base}: ${inner}`;
  if (status !== undefined && !message.includes(String(status))) message = `${message} (${status})`;
  const resetsAt = [fields["resetsAt"], fields["resets_at"], fields["resetAt"], fields["reset_at"], nested["resetsAt"], nested["resets_at"]]
    .map(epochSeconds)
    .find((value) => value !== undefined);
  return { message: message.slice(0, 600), ...(status !== undefined ? { status } : {}), ...(resetsAt !== undefined ? { resetsAt } : {}) };
}

/**
 * Normalize any thrown value into a typed yagami error for `provider`,
 * recognizing sign-in failures and a used-up plan by message.
 */
export function classifyProviderFailure(provider: string, loginCommand: string, err: unknown): YagamiError {
  if (err instanceof YagamiError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (looksLikeUsageLimit(message)) return new UsageLimitError(provider, undefined, message.split("\n")[0]!.slice(0, 300));
  if (looksLikeAuthFailure(message)) {
    return new AuthRequiredError(provider, loginCommand, message.split("\n")[0]?.slice(0, 200));
  }
  return new ProviderError(provider, message);
}

/**
 * Map any failure onto the Anthropic-shaped HTTP error the API returns. The
 * original failure rides along as `cause`.
 */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof AuthRequiredError || err instanceof ProviderNotInstalledError) {
    return new ApiError(503, "api_error", err.message, { cause: err });
  }
  if (err instanceof UsageLimitError) return new ApiError(429, "rate_limit_error", err.message, { cause: err });
  // the harness's upstream said slow down: that is the caller's to know, not a server fault
  if (err instanceof ProviderError && err.status === 429) return new ApiError(429, "rate_limit_error", err.message, { cause: err });
  if (err instanceof YagamiError) return new ApiError(500, "api_error", err.message, { cause: err });
  const message = err instanceof Error ? err.message : String(err);
  return new ApiError(500, "api_error", `engine error: ${message}`, { cause: err });
}
