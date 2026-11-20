// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AboutWindow } from "./AboutWindow";
import { readFileSync } from "node:fs";
import contributors from "./contributors.json";

it("renders release metadata, sourced credits and licenses and copies the version on request", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("__ABOUT_PROVENANCE__", {
    components: [{ name: "RDKit MinimalLib WASM", version: "Release_2026_03_3",
      license: "BSD-3-Clause", purpose: "Chemistry engine", sourceUrl: "https://github.com/rdkit/rdkit" }],
    licenseTexts: { LICENSE: readFileSync("LICENSE", "utf8") }
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onCopy = vi.fn(async () => {});
  const onReady = vi.fn();
  const button = (text: string) => [...container.querySelectorAll("button")].find(element => element.textContent === text)!;
  try {
    await act(async () => root.render(<AboutWindow version="1.2.2" buildStamp="11.19.18.03-codex" onCopy={onCopy} onReady={onReady} />));
    expect(onReady).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Version 1.2.2");
    expect(container.textContent).toContain("Build 11.19.18.03-codex");
    expect(container.textContent).toContain("Free and open source under the Apache License 2.0.");
    expect(container.textContent).toContain("ChemDraft was developed with AI coding assistants.");
    for (const { name, handle, contribution, sources } of contributors) {
      expect(container.textContent).toContain(name);
      expect(container.textContent).toContain(contribution);
      expect(container.querySelector('a[href="https://github.com/' + handle + '"]')?.textContent).toBe("@" + handle);
      expect(sources.length).toBeGreaterThan(0);
    }
    expect(container.textContent).toContain("Open-source components and provenance");
    expect(container.textContent).toContain("RDKit MinimalLib WASM");
    expect(container.textContent).not.toMatch(/chemdraw|marvin(?:sketch)?|isischem|isis\/draw|chemsketch|chemwindow/i);
    await act(async () => { button("Copy Version").click(); });
    expect(onCopy).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Version copied.");
    await act(async () => { button("Read the license").click(); });
    expect(container.querySelector("pre")?.textContent).toContain("Apache License");
    await act(async () => { button("Back to About ChemDraft").click(); });
    expect(container.textContent).toContain("Version 1.2.2");
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
