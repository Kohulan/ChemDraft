import { useEffect, useState } from "react";
import { structureInteractive3dCommandId } from "./commands";
import { readEngine3dSidecarStatus, type Engine3dSidecarStatus } from "./engine3dSidecar";
import { isDesktopRuntime } from "./window-manager";

const NONE: ReadonlySet<string> = new Set();

const INTERACTIVE_3D_UNAVAILABLE: ReadonlySet<string> = new Set([structureInteractive3dCommandId]);

/**
 * Commands this build cannot provide for the whole session. AGENTS.md §10: such tools are removed
 * from toolbars, menus, palettes and the Customize gallery, never shown permanently disabled;
 * `disabledReason` is only for transient, state-dependent unavailability.
 *
 * Interactive 3D needs the 3D sidecar. The shell reports `available: false` only when neither the
 * developer override nor the bundled binary can run (missing, a `binaries/` placeholder, or not
 * executable), and neither changes while the app runs. The browser build has no desktop bridge and
 * so no sidecar at all: it leaves Interactive 3D out from the start. In the desktop build, before
 * the status is known (`undefined`), nothing is removed. Spin 3D does not use the sidecar, so it
 * always stays. The native menu applies the same rule in Rust (`interactive3d_menu_item_shown` in
 * lib.rs).
 */
export function sessionUnavailableCommandIds(
  sidecar: Engine3dSidecarStatus | undefined,
  desktop: boolean = isDesktopRuntime()
): ReadonlySet<string> {
  if (!desktop) return INTERACTIVE_3D_UNAVAILABLE;
  return sidecar?.available === false ? INTERACTIVE_3D_UNAVAILABLE : NONE;
}

/**
 * `commands` without the session's unavailable ones, for command lists built before the status was
 * known (a palette's fallback specs feed its Customize gallery and shortcuts). The same array when
 * nothing is unavailable.
 */
export function withoutSessionUnavailableCommands<T extends { readonly id: string }>(
  commands: readonly T[],
  unavailable: ReadonlySet<string>
): readonly T[] {
  return unavailable.size === 0 ? commands : commands.filter(command => !unavailable.has(command.id));
}

/** Read once per window: the bundled sidecar is fixed for the life of the process. */
export function useSessionUnavailableCommandIds(desktop: boolean = isDesktopRuntime()): ReadonlySet<string> {
  // Without a desktop bridge the answer is already known; with one it is pending until the status.
  const [ids, setIds] = useState(() => sessionUnavailableCommandIds(undefined, desktop));
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    void readEngine3dSidecarStatus().then(status => {
      if (!disposed) setIds(sessionUnavailableCommandIds(status, desktop));
    });
    return () => { disposed = true; };
  }, [desktop]);
  return ids;
}
