/**
 * Merges `overrides` onto `base`, ignoring keys whose value is `undefined`.
 *
 * A plain object spread copies `undefined` values over the defaults, which silently
 * breaks forward/backward compatibility: a stored settings object that carries an
 * explicit `undefined` (IndexedDB preserves it, unlike JSON) would wipe out the default
 * instead of falling back to it.
 */
export function mergeDefined<T extends object>(base: T, overrides: Partial<T> | undefined): T {
  if (!overrides) return { ...base };
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) (result as Record<string, unknown>)[key] = value;
  }
  return result;
}
