// Test-only. Used from a test file whose `vi.mock("./cdxmlLimits", ...)` swaps in a mutable copy of
// the caps; against the real, frozen module the assignment below throws, so this cannot weaken
// production. Nothing in production imports this file.
import { cdxmlLimits, type CdxmlLimits } from "../cdxmlLimits";

/** Runs `run` with some caps lowered; the previous values are restored afterwards. */
export function withCdxmlLimitsForTesting<T>(overrides: Partial<{ -readonly [K in keyof CdxmlLimits]: number }>, run: () => T): T {
  const target = cdxmlLimits as { -readonly [K in keyof CdxmlLimits]: number };
  const saved = { ...target };
  Object.assign(target, overrides);
  try {
    return run();
  } finally {
    Object.assign(target, saved);
  }
}
