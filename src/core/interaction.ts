import type {
  SessionInputField,
  SessionInputRequest,
  SessionInputResponse,
  SessionInputValue,
} from "./provider.js";

type Raw = Record<string, unknown>;

function record(value: unknown): Raw | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Raw)
    : undefined;
}

function optionsOf(schema: Raw): Array<{ value: string; label: string; description?: string }> | undefined {
  const oneOf = Array.isArray(schema["oneOf"]) ? schema["oneOf"] : undefined;
  if (oneOf) {
    const options = oneOf.flatMap((item) => {
      const value = record(item);
      if (!value || typeof value["const"] !== "string") return [];
      return [{
        value: value["const"],
        label: typeof value["title"] === "string" ? value["title"] : value["const"],
        ...(typeof value["description"] === "string" ? { description: value["description"] } : {}),
      }];
    });
    if (options.length > 0) return options;
  }
  const values = Array.isArray(schema["enum"])
    ? schema["enum"].filter((value): value is string => typeof value === "string")
    : [];
  return values.length > 0 ? values.map((value) => ({ value, label: value })) : undefined;
}

/** Convert the primitive JSON-Schema subset used by MCP/ACP into host fields. */
export function inputFields(schema: unknown): SessionInputField[] {
  const root = record(schema);
  const properties = record(root?.["properties"]);
  if (!properties) return [];
  const required = new Set(
    Array.isArray(root?.["required"])
      ? root["required"].filter((value): value is string => typeof value === "string")
      : [],
  );
  return Object.entries(properties).flatMap(([id, value]) => {
    const property = record(value);
    if (!property || typeof property["type"] !== "string") return [];
    let type: SessionInputField["type"];
    let options = optionsOf(property);
    if (property["type"] === "array") {
      type = "multiselect";
      options = optionsOf(record(property["items"]) ?? {});
    } else if (property["type"] === "string" && options) {
      type = "select";
    } else if (["string", "number", "integer", "boolean"].includes(property["type"])) {
      type = property["type"] as SessionInputField["type"];
    } else {
      return [];
    }
    const defaultValue = property["default"];
    return [{
      id,
      label: typeof property["title"] === "string" ? property["title"] : id,
      type,
      required: required.has(id),
      ...(typeof property["description"] === "string" ? { description: property["description"] } : {}),
      ...(options ? { options } : {}),
      ...(typeof property["format"] === "string" ? { format: property["format"] } : {}),
      ...(typeof property["minimum"] === "number" ? { minimum: property["minimum"] } : {}),
      ...(typeof property["maximum"] === "number" ? { maximum: property["maximum"] } : {}),
      ...(typeof property["minLength"] === "number" ? { minLength: property["minLength"] } : {}),
      ...(typeof property["maxLength"] === "number" ? { maxLength: property["maxLength"] } : {}),
      ...(typeof defaultValue === "string" || typeof defaultValue === "number" || typeof defaultValue === "boolean" ||
      (Array.isArray(defaultValue) && defaultValue.every((item) => typeof item === "string"))
        ? { default: defaultValue as SessionInputValue }
        : {}),
    }];
  });
}

/** Normalize an MCP/ACP elicitation request. */
export function elicitationRequest(
  provider: string,
  sessionId: string | undefined,
  raw: Raw,
): SessionInputRequest {
  const mode = raw["mode"];
  if (mode === "url") {
    return {
      provider,
      ...(sessionId ? { sessionId } : {}),
      kind: "url",
      message: typeof raw["message"] === "string" ? raw["message"] : "Open the requested URL",
      ...(typeof raw["serverName"] === "string" ? { source: raw["serverName"] } : {}),
      ...(typeof raw["url"] === "string" ? { url: raw["url"] } : {}),
      raw,
    };
  }
  return {
    provider,
    ...(sessionId ? { sessionId } : {}),
    kind: "form",
    message: typeof raw["message"] === "string" ? raw["message"] : "Input requested",
    ...(typeof raw["serverName"] === "string" ? { source: raw["serverName"] } : {}),
    fields: inputFields(raw["requestedSchema"]),
    raw,
  };
}

export function declineInput(): SessionInputResponse {
  return { action: "decline" };
}

export function elicitationResponse(response: SessionInputResponse): Raw {
  return response.action === "accept"
    ? { action: "accept", content: response.values ?? null }
    : { action: response.action };
}
