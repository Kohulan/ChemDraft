import { useId, useMemo, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CommandSpec } from "../../commands";

export interface CustomizeItemModel {
  /** Customization id (command id or `widget.*` control id). */
  id: string;
  label: string;
  hidden: boolean;
  isWidget: boolean;
  canRemove: boolean;
}

export interface CustomizeGroupModel {
  id: string;
  title?: string;
  items: CustomizeItemModel[];
}

export type CommandOption = Pick<CommandSpec, "id" | "title"> & Partial<Pick<CommandSpec, "icon" | "assetName">>;

export interface CustomizeToolsetDetailProps {
  toolsetTitle: string;
  groups: readonly CustomizeGroupModel[];
  /** Commands not already in this toolset, for the "add" palette. */
  availableCommands: readonly CommandOption[];
  onReorderItems: (groupId: string, orderedItemIds: string[]) => void;
  onToggleItemHidden: (itemId: string, hidden: boolean) => void;
  onRemoveItem: (groupId: string, itemId: string) => void;
  onAddCommand: (command: CommandOption) => void;
}

function SortableItemRow({
  item,
  onToggleHidden,
  onRemove
}: {
  item: CustomizeItemModel;
  onToggleHidden: (hidden: boolean) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  return (
    <li
      ref={setNodeRef}
      className="customize-item-row"
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 }}
      data-item-id={item.id}
    >
      <button type="button" className="customize-drag-handle" aria-label={`Reorder ${item.label}`} {...attributes} {...listeners}>
        ⠿
      </button>
      <input
        type="checkbox"
        className="customize-item-visible"
        aria-label={`Show ${item.label}`}
        checked={!item.hidden}
        onChange={(event) => onToggleHidden(!event.currentTarget.checked)}
      />
      <span className="customize-item-label">
        {item.label}
        {item.isWidget ? <span className="customize-item-widget-tag"> · widget</span> : null}
      </span>
      {item.canRemove ? (
        <button type="button" className="customize-item-action customize-item-remove" aria-label={`Remove ${item.label}`} onClick={onRemove}>
          Remove
        </button>
      ) : null}
    </li>
  );
}

export function CustomizeToolsetDetail({
  toolsetTitle,
  groups,
  availableCommands,
  onReorderItems,
  onToggleItemHidden,
  onRemoveItem,
  onAddCommand
}: CustomizeToolsetDetailProps) {
  const [search, setSearch] = useState("");
  const [showCommandPicker, setShowCommandPicker] = useState(false);
  const commandPickerId = useId();
  const sensors = useSensors(
    // See CustomizeToolbarsDialog: a 5px activation distance separates click from drag so the native
    // WKWebView doesn't start-then-cancel drags on a plain click's micro-movement.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const filteredCommands = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matches = query.length === 0
      ? availableCommands
      : availableCommands.filter(
          (command) => command.title.toLowerCase().includes(query) || command.id.toLowerCase().includes(query)
        );
    return matches.slice(0, 40);
  }, [availableCommands, search]);

  const handleDragEnd = (groupId: string, itemIds: string[]) => (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }
    const from = itemIds.indexOf(String(active.id));
    const to = itemIds.indexOf(String(over.id));
    if (from < 0 || to < 0) {
      return;
    }
    onReorderItems(groupId, arrayMove(itemIds, from, to));
  };

  return (
    <section className="customize-detail" aria-label={`${toolsetTitle} contents`}>
      <h3 className="customize-detail-title">{toolsetTitle}</h3>
      <button
        type="button"
        className="customize-toolset-action customize-command-picker-toggle"
        aria-expanded={showCommandPicker}
        aria-controls={commandPickerId}
        onClick={() => setShowCommandPicker((shown) => !shown)}
      >
        Add command…
      </button>
      <div className="customize-command-palette" id={commandPickerId} hidden={!showCommandPicker}>
        {showCommandPicker ? (
          <>
            <input
              type="text"
              aria-label="Search commands to add"
              placeholder="Search commands to add…"
              autoFocus
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
            />
            <ul className="customize-command-results">
              {filteredCommands.map((command) => (
                <li key={command.id}>
                  <button
                    type="button"
                    className="customize-command-add"
                    data-command-id={command.id}
                    onClick={() => onAddCommand(command)}
                  >
                    + {command.title}
                  </button>
                </li>
              ))}
              {filteredCommands.length === 0 ? <li className="customize-command-empty">No matching commands.</li> : null}
            </ul>
          </>
        ) : null}
      </div>
      {groups.length === 0 ? <p className="customize-detail-empty">This toolbar has no items yet.</p> : null}
      {groups.map((group) => {
        const itemIds = group.items.map((item) => item.id);
        return (
          <div className="customize-detail-group" key={group.id} data-group-id={group.id}>
            {group.title ? <h4 className="customize-detail-group-title">{group.title}</h4> : null}
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd(group.id, itemIds)}>
              <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
                <ul className="customize-item-list">
                  {group.items.map((item) => (
                    <SortableItemRow
                      key={item.id}
                      item={item}
                      onToggleHidden={(hidden) => onToggleItemHidden(item.id, hidden)}
                      onRemove={() => onRemoveItem(group.id, item.id)}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          </div>
        );
      })}
    </section>
  );
}
