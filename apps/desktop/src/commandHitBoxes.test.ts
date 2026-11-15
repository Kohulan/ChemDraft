// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { commandButtonHitBoxes, physicalClientRect } from "./commandHitBoxes";

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

});
