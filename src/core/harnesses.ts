/**
 * The harness list a host shows its user: every coding-agent CLI yagami
 * knows, whether it is installed, whether it is signed in, and what to run
 * when it isn't. Built without asking any model anything.
 */

import { loadHostEngineConfig } from "./hostConfig.js";
import type { Provider, ProviderStatus } from "./provider.js";
import { createProvider, detectProviders, type ProviderConfigEntry, type ProviderKind } from "./providers/registry.js";

export interface Harness {
  id: string;
  /** Human name: "Claude Code", "Grok Build", … */
  label: string;
  /** How yagami drives it. "custom" is a provider instance the host passed in itself. */
  kind: ProviderKind | "custom";
  installed: boolean;
  /** Resolved path of the CLI, when installed. */
  path?: string;
  /**
   * Signed in? Left out when the check was skipped (`status: false`), the
   * CLI isn't installed, or the harness gives no way to tell short of
   * running a turn.
   */
  signedIn?: boolean;
  /** Installed and not known to be signed out: a turn is worth sending. */
  available: boolean;
  /** Account the CLI is signed in as, where it says. */
  account?: string;
  /** Plan name, where it says ("max", "pro", …). */
  plan?: string;
  /** What to run to sign in. */
  loginCommand: string;
  /** What to run to install it. */
  installHint: string;
  /** The harness's own words for why it is unavailable, or what the check ran into. */
  detail?: string;
  /** Receives turns that name no harness. */
  isDefault: boolean;
  /** What a turn on this harness can carry. Present when installed. */
  capabilities?: {
    images: boolean;
    /** Takes a system prompt natively; otherwise yagami folds it into the prompt. */
    systemPrompt: boolean;
    effort: boolean;
    webSearch: boolean;
  };
}

export interface ListHarnessesOptions {
  /** Per-harness settings (`providers.<id>` in config.json). Default: the host's yagami config. */
  providerConfig?: Record<string, ProviderConfigEntry>;
  /** Read ~/.config/yagami/config.json when `providerConfig` is not given (default true). */
  syncHostConfig?: boolean;
  /**
   * Check sign-in for the installed ones (default true). Each check starts
   * the CLI briefly; pass false for a list that only needs install state.
   */
  status?: boolean;
  /** Provider instances to check instead of building fresh ones (an engine's own). */
  providers?: Map<string, Provider>;
  defaultProvider?: string;
}

/**
 * Every known harness with its install and sign-in state. Works on a machine
 * with nothing installed, which is exactly when a host needs the install
 * hints. Never throws for a harness that misbehaves: that harness's `detail`
 * says what happened.
 */
export async function listHarnesses(options: ListHarnessesOptions = {}): Promise<Harness[]> {
  const host = options.providerConfig || options.syncHostConfig === false ? {} : loadHostEngineConfig();
  const config = options.providerConfig ?? host.providerConfig ?? {};
  const detected = detectProviders(config);
  const known = new Set(detected.map((d) => d.id));
  const rows: Array<Omit<Harness, "isDefault" | "available" | "signedIn"> & { provider?: Provider }> = detected.map((d) => {
    let provider = options.providers?.get(d.id);
    let detail: string | undefined;
    if (!provider && d.installed && !options.providers) {
      try {
        provider = createProvider(d.id, config[d.id] ?? {}, {});
      } catch (err) {
        detail = err instanceof Error ? err.message : String(err);
      }
    }
    return {
      id: d.id,
      label: provider?.label ?? d.label,
      kind: d.kind,
      // an engine may have found a CLI where the plain PATH lookup did not
      installed: d.installed || provider !== undefined,
      ...(provider ? { path: provider.executable } : d.path ? { path: d.path } : {}),
      loginCommand: provider?.loginCommand ?? d.loginCommand,
      installHint: d.installHint,
      ...(detail ? { detail } : {}),
      ...(provider ? { provider } : {}),
    };
  });
  for (const [id, provider] of options.providers ?? []) {
    if (known.has(id)) continue;
    rows.push({ id, label: provider.label, kind: "custom", installed: true, path: provider.executable, loginCommand: provider.loginCommand, installHint: "", provider });
  }

  const installed = rows.filter((r) => r.installed).map((r) => r.id);
  const wanted = options.defaultProvider ?? host.defaultProvider;
  const defaultId = wanted && installed.includes(wanted) ? wanted : installed.includes("claude") ? "claude" : installed[0];

  return Promise.all(
    rows.map(async ({ provider, ...row }): Promise<Harness> => {
      let status: ProviderStatus = {};
      if (provider?.status && options.status !== false) {
        status = await provider.status().catch((err: unknown) => ({ detail: err instanceof Error ? err.message : String(err) }));
      }
      const detail = status.detail ?? row.detail;
      return {
        ...row,
        ...(status.loginCommand ? { loginCommand: status.loginCommand } : {}),
        ...(status.signedIn !== undefined ? { signedIn: status.signedIn } : {}),
        available: row.installed && provider !== undefined && status.signedIn !== false,
        ...(status.account ? { account: status.account } : {}),
        ...(status.plan ? { plan: status.plan } : {}),
        ...(detail ? { detail } : {}),
        isDefault: row.id === defaultId,
        ...(provider
          ? {
              capabilities: {
                images: provider.capabilities.images,
                systemPrompt: provider.capabilities.systemPrompt,
                effort: provider.capabilities.effort,
                webSearch: provider.capabilities.serverTools,
              },
            }
          : {}),
      };
    }),
  );
}
