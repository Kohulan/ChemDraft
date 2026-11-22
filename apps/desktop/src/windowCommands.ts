import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import type { CommandSpec } from "./commands";

/**
 * Window ▸ Minimize, Maximize / Restore and Close Window on Linux.
 *
 * muda leaves its predefined window items out of GTK menus, so the Linux native menu builds ordinary
 * items backed by these registry commands (`LINUX_WINDOW_COMMAND_IDS` in lib.rs). A click routes to
 * the document window's command dispatcher like any other menu item; the command then asks Rust for
 * the native action on the document window over {@link WINDOW_ACTION_EVENT}.
 *
 * macOS and Windows keep the predefined OS items, which act natively and never reach the registry,
 * so these commands exist only in the Linux desktop build: nowhere else do they show, disabled or not.
 */
export type WindowCommandAction = "minimize" | "toggleMaximize" | "close";

/** Mirrors `WINDOW_ACTION_EVENT` in apps/desktop/src-tauri/src/lib.rs. */
export const WINDOW_ACTION_EVENT = "chemdraft://window-action";

const WINDOW_COMMAND_TITLES: Readonly<Record<WindowCommandAction, string>> = {
  minimize: "Minimize",
  toggleMaximize: "Maximize / Restore",
  close: "Close Window"
};

const WINDOW_COMMAND_ACTIONS = Object.keys(WINDOW_COMMAND_TITLES) as WindowCommandAction[];

export function windowCommandId(action: WindowCommandAction): string {
  return `window.${action}`;
}

/** The value-encoded ids of every window command, in Window-menu order. */
export const windowCommandIds: readonly string[] = WINDOW_COMMAND_ACTIONS.map(windowCommandId);

/** Only the Linux desktop build has a menu that routes these; elsewhere the OS items act natively. */
export function windowCommandsSupported(info: { isDesktop: boolean; platform: ShortcutPlatform }): boolean {
  return info.isDesktop && info.platform === "linux";
}

export function windowCommands(info: { isDesktop: boolean; platform: ShortcutPlatform }): CommandSpec[] {
  if (!windowCommandsSupported(info)) return [];
  return WINDOW_COMMAND_ACTIONS.map(action => ({
    id: windowCommandId(action),
    title: WINDOW_COMMAND_TITLES[action],
    // No shortcut: a Linux menu accelerator would take Ctrl+W (document.closeTab) from the webview.
    icon: action === "close" ? "close" as const : "open" as const,
    source: "core" as const,
    category: "app",
    description: action === "close"
      ? "Close the document window, as its title-bar close button does"
      : `${WINDOW_COMMAND_TITLES[action]} the document window`
  }));
}

export type WindowActionEmitter = (event: string, payload: { commandId: string }) => Promise<void>;

async function emitAppEvent(event: string, payload: { commandId: string }): Promise<void> {
  const { emit } = await import("@tauri-apps/api/event");
  await emit(event, payload);
}

/** Ask the native side to run a window command on the document window. */
export async function requestWindowAction(commandId: string, emitEvent: WindowActionEmitter = emitAppEvent): Promise<void> {
  if (!windowCommandIds.includes(commandId)) throw new Error(`${commandId} is not a window command`);
  await emitEvent(WINDOW_ACTION_EVENT, { commandId });
}
