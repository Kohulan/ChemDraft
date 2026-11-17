// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { commandButtonHitBoxes, nativeChooserHitBoxes, observePaletteHitBoxes, physicalClientRect } from "./commandHitBoxes";

describe("detached palette native command hit regions", () => {
  it("scales fractional CSS bounds into physical client pixels", () => {
    expect(physicalClientRect({ left: 10.2, top: 4.1, right: 30.1, bottom: 24.2 }, 1.5))
      .toEqual({ x: 15, y: 6, width: 31, height: 31 });
  });

  it("covers all command buttons, including disabled and custom commands, while excluding editing and customization", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <button data-native-noactivate-command="true"></button>
      <input type="color" />
      <button data-native-noactivate-command="true" disabled></button>
      <button data-command-id="tool.select"></button>
      <button data-command-id="plugin.demo.action"></button>
      <div class="customizing"><button data-command-id="tool.select"></button></div>
      <button role="slider"></button>
      <div class="art-color-popover"><button role="tab"></button></div>
    `;
    for (const button of root.querySelectorAll("button")) {
      button.getBoundingClientRect = () => ({ left: 5, top: 7, right: 25, bottom: 27, width: 20, height: 20, x: 5, y: 7, toJSON: () => ({}) });
    }
    expect(commandButtonHitBoxes(root, 2)).toEqual(Array.from({ length: 4 }, () => ({ x: 10, y: 14, width: 40, height: 40 })));
  });

  it("publishes only enabled visible native colour and select choosers", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <input type="color"><select></select><input type="text"><textarea></textarea>
      <input type="color" disabled><fieldset disabled><select></select></fieldset>
      <div hidden><input type="color"></div><select style="visibility:hidden"></select>
    `;
    document.body.append(root);
    for (const element of root.querySelectorAll("input, select, textarea")) {
      element.getBoundingClientRect = () => new DOMRect(5, 10, 20, 30);
    }
    expect(nativeChooserHitBoxes(root, 1.5)).toEqual([
      { x: 7, y: 15, width: 31, height: 45 }, { x: 7, y: 15, width: 31, height: 45 }
    ]);
    root.remove();
  });

  it("atomically replaces snapshots after DOM changes, refresh and scroll, without clearing on observer cleanup", async () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    root.innerHTML = '<button></button><input type="color">';
    document.body.append(root);
    for (const element of root.children) element.getBoundingClientRect = () => new DOMRect(5, 10, 20, 30);
    const publish = vi.fn(async (_boxes: unknown[], _chooserRects: unknown[]) => {});
    const unsubscribe = vi.fn();
    let refresh!: () => void;
    const stop = observePaletteHitBoxes(root, publish, async callback => {
      refresh = callback;
      return unsubscribe;
    });
    try {
      await vi.advanceTimersByTimeAsync(20);
      expect(publish).toHaveBeenCalledExactlyOnceWith(
        [{ x: 5, y: 10, width: 20, height: 30 }], [{ x: 5, y: 10, width: 20, height: 30 }]);
      root.querySelector("button")!.disabled = true; // Selection/availability broadcast.
      await Promise.resolve();
      expect(publish).toHaveBeenCalledTimes(1); // Old snapshot survives until replacement.
      await vi.advanceTimersByTimeAsync(20);
      expect(publish).toHaveBeenCalledTimes(2);
      refresh(); // Native reveal after it cleared the hidden window's rects.
      await vi.advanceTimersByTimeAsync(20);
      expect(publish).toHaveBeenCalledTimes(3);
      window.dispatchEvent(new Event("scroll"));
      stop(); // A queued frame must not republish after unmount.
      await vi.advanceTimersByTimeAsync(20);
      expect(publish).toHaveBeenCalledTimes(3);
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(publish.mock.calls.every(([boxes]) => boxes.length > 0)).toBe(true);
    } finally {
      stop();
      root.remove();
      vi.useRealTimers();
    }
  });
});
