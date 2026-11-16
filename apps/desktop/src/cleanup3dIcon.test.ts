import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Icon, ToolbarAssetIcon } from "./icons";
import { toolbarAsset } from "./toolbarAssets";
import { CommandIconButton, ToolbarItemIcon } from "./ToolPalette";
import { getToolsetCommandSpecs, getToolsetItemGroups } from "./toolsets";

describe("3D cleanup sponge icon", () => {
  const commands = getToolsetCommandSpecs();
  const cleanup = commands.find(command => command.id === "structure.cleanup3d")!;
  const spin = commands.find(command => command.id === "structure.spin3d")!;

  it("resolves distinct artwork for cleanup and Spin 3D, including native flyout asset keys", () => {
    expect(cleanup.assetName).toBe("Custom_Structure_Cleanup_3D");
    expect(spin.assetName).toBe("Custom_Spin_3D");
    const cleanupMarkup = renderToStaticMarkup(createElement(ToolbarAssetIcon, {
      assetName: cleanup.assetName, src: toolbarAsset(cleanup.assetName!)
    }));
    const spinMarkup = renderToStaticMarkup(createElement(ToolbarAssetIcon, {
      assetName: spin.assetName, src: toolbarAsset(spin.assetName!)
    }));
    expect(cleanupMarkup).toContain('<svg');
    expect(cleanupMarkup).toContain('stroke="currentColor"');
    expect(spinMarkup).toContain('<img');
    expect(spinMarkup).toContain(toolbarAsset("Custom_Spin_3D"));
    expect(cleanupMarkup).not.toBe(spinMarkup);
  });

  it.each(["core.main", "core.structure"])("renders the sponge in %s and its Customize preview", toolsetId => {
    const items = getToolsetItemGroups(toolsetId).flat();
    const item = items.find(item => item.primary.type === "command" && item.primary.command.id === cleanup.id);
    expect(item).toBeDefined();
    const markup = renderToStaticMarkup(createElement(ToolbarItemIcon, { item: item!, command: cleanup }));
    expect(markup).toBe(renderToStaticMarkup(createElement(Icon, { name: "sponge3d" })));
    // The gallery uses this same renderer with command metadata even without an item asset.
    expect(renderToStaticMarkup(createElement(ToolbarItemIcon, {
      item: { ...item!, assetName: undefined }, command: cleanup
    }))).toBe(markup);
  });

  it("uses the shared line-icon grid and inherited color for light, dark and disabled controls", () => {
    const markup = renderToStaticMarkup(createElement(Icon, { name: "sponge3d" }));
    expect(markup).toContain('viewBox="0 0 24 24"');
    expect(markup).toContain('fill="none" stroke="currentColor" stroke-width="1.8"');
    expect(markup).not.toMatch(/#[0-9a-f]{3,8}/i);
    const disabledMarkup = renderToStaticMarkup(createElement(CommandIconButton, {
      command: { ...cleanup, enabled: false, disabledReason: "Select a molecule" },
      active: false,
      onInvoke: () => undefined
    }));
    expect(disabledMarkup).toContain('disabled=""');
    expect(disabledMarkup).toContain(markup);
  });
});
