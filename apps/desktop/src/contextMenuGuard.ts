/** Suppress native menus, including editable-field menus that may offer Reload. */
export function installContextMenuGuard(target: Document = document): () => void {
  const guard = (event: MouseEvent) => {
    event.preventDefault();
  };
  target.addEventListener("contextmenu", guard);
  return () => target.removeEventListener("contextmenu", guard);
}
