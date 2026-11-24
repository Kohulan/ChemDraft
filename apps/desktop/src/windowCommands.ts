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

/**
 * Commands that act on the whole document window: closing a tab, and the window commands, whose
 * native half minimizes, maximizes or closes it. A plugin panel or a plugin report must never reach
 * them (AGENTS.md sections 3 and 4); the native panel shortcut bridge refuses the same set
 * (`panel_shortcut_reaches_document_window` in lib.rs). A `:` routing suffix or `.` variant counts.
 */
export function isDocumentWindowCommandId(commandId: string): boolean {
  const command = commandId.split(":", 1)[0];
  return ["document.closeTab", ...windowCommandIds].some((blocked) =>
    command === blocked || command.startsWith(`${blocked}.`));
}

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

/** The document window's label (`MAIN_WINDOW_LABEL` in lib.rs). */
export const DOCUMENT_WINDOW_LABEL = "main";

async function emitAppEvent(event: string, payload: { commandId: string }): Promise<void> {
  const { emit } = await import("@tauri-apps/api/event");
  await emit(event, payload);
}

async function currentWindowLabel(): Promise<string> {
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return getCurrentWebviewWindow().label;
}

/**
 * Ask the native side to run a window command on the document window. The native half always acts
 * on the document window, so only the document window may ask: a palette, dialog or panel that
 * somehow dispatched one of these commands is refused here rather than acting on a window it is not.
 */
export async function requestWindowAction(
  commandId: string,
  emitEvent: WindowActionEmitter = emitAppEvent,
  sourceLabel: () => Promise<string> = currentWindowLabel
): Promise<void> {
  if (!windowCommandIds.includes(commandId)) throw new Error(`${commandId} is not a window command`);
  const label = await sourceLabel();
  if (label !== DOCUMENT_WINDOW_LABEL) {
    throw new Error(`${commandId} runs only in the document window, not "${label}"`);
  }
  await emitEvent(WINDOW_ACTION_EVENT, { commandId });
}
