/**
 * API 0.1.27: optional machine-readable fields a host may attach to a refusal, beside its human
 * message, so a plugin can act on it without parsing text. Both are absent unless the host has a
 * specific reason; a plugin must keep handling a refusal that carries neither.
 *
 * - `reason`: a stable snake_case identifier, such as `hydrogen_count_unrepresentable` (a write
 *   would store a hydrogen count other than 0 on an H, D or T atom).
 * - `details`: a flat record of what the refusal is about, such as
 *   `{ moleculeId, atomId, element, hydrogenCount }`.
 */
export type PluginRefusalDetails = Readonly<Record<string, string | number | boolean>>;

export interface PluginRefusalFields {
  reason?: string;
  details?: PluginRefusalDetails;
}

/** Bounds shared by the worker error payload and the request error schema. */
export const PluginRefusalLimits = {
  reasonPattern: /^[a-z][a-z0-9_]{0,63}$/,
  detailKeys: 16,
  detailKeyLength: 64,
  detailStringLength: 256
} as const;

function isDetailValue(value: unknown): value is string | number | boolean {
  return typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.length <= PluginRefusalLimits.detailStringLength);
}

/**
 * The valid refusal fields of an untrusted value (an error or an error payload), detached. A malformed
 * field is dropped rather than failing the refusal it rides on: the message still settles the call.
 */
export function pluginRefusalFields(value: unknown): PluginRefusalFields {
  if (typeof value !== "object" || value === null) return {};
  const { reason, details } = value as { reason?: unknown; details?: unknown };
  const fields: { reason?: string; details?: PluginRefusalDetails } = {};
  if (typeof reason === "string" && PluginRefusalLimits.reasonPattern.test(reason)) fields.reason = reason;
  if (typeof details === "object" && details !== null && !Array.isArray(details) &&
      Object.getPrototypeOf(details) === Object.prototype) {
    const entries = Object.entries(details);
    if (entries.length <= PluginRefusalLimits.detailKeys && entries.every(([key, item]) =>
      key.length > 0 && key.length <= PluginRefusalLimits.detailKeyLength && isDetailValue(item))) {
      fields.details = Object.freeze(Object.fromEntries(entries));
    }
  }
  return fields;
}
