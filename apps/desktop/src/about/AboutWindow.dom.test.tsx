// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AboutWindow, BrowserAboutWindow } from "./AboutWindow";
import { readFileSync } from "node:fs";
import contributors from "./contributors.json";
import testers from "./testers.json";
import packageInfo from "../../package.json";

it("renders release metadata, sourced credits and licenses and copies the version on request", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("__ABOUT_PROVENANCE__", {
    components: [
      { name: "RDKit MinimalLib WASM", version: "Release_2026_03_3", license: "BSD-3-Clause",
        holders: ["Copyright (c) 2006-2026 Rational Discovery LLC"], purpose: "Chemistry engine", sourceUrl: "https://github.com/rdkit/rdkit" },
      { name: "example-package", version: "1.0.0", license: "MIT", holders: ["see license"],
        purpose: "Test package", sourceUrl: "https://example.com/package" }
    ],
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
      if (handle) expect(container.querySelector('a[href="https://github.com/' + handle + '"]')?.textContent).toBe("@" + handle);
      expect(sources.length).toBeGreaterThan(0);
    }
    expect(container.textContent).toContain("Clemens Kaussler");
    expect(container.textContent).toContain("Ilm-NMR-P31 phosphorus NMR data");
    const tested = [...container.querySelectorAll("details")].find(element => element.textContent?.includes("Bug reports and testing"))!;
    expect(tested.querySelector("summary")?.textContent).toBe("Bug reports and testing (" + testers.handles.length + ")");
    for (const handle of testers.handles) expect(tested.querySelector('a[href="https://github.com/' + handle + '"]')?.textContent).toBe("@" + handle);
    expect(tested.querySelectorAll("li").length).toBe(testers.handles.length);
    expect(container.textContent).toContain("Open-source components and provenance");
    expect(container.textContent).toContain("RDKit MinimalLib WASM");
    expect(container.textContent).toContain("Authors and copyright holders: Copyright (c) 2006-2026 Rational Discovery LLC");
    expect(container.textContent).toContain("Authors and copyright holders: see license");
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

it("lists only the components the chosen platform ships, from one test host", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const component = (name: string, platforms?: "all" | Array<"macos" | "windows" | "linux">) => ({
    name, version: "1.0.0", license: "MIT", holders: ["see license"], purpose: "Test package",
    sourceUrl: "https://example.com/" + name, ...(platforms ? { platforms } : {})
  });
  vi.stubGlobal("__ABOUT_PROVENANCE__", {
    components: [
      component("shared-crate", "all"), component("untagged-crate"), component("zbus", ["linux"]), component("webkit2gtk", ["linux"]),
      component("windows-sys", ["windows"]), component("objc2", ["macos"]), component("single-instance", ["windows", "linux"])
    ],
    licenseTexts: { LICENSE: "Apache License" }
  });
  const render = async (platform: "macos" | "windows" | "linux") => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<AboutWindow version="1.2.2" buildStamp="test" platform={platform} onCopy={async () => {}} />));
    const names = [...container.querySelectorAll(".about-credits h3")].map(heading => heading.textContent);
    const summary = [...container.querySelectorAll("summary")].find(element => element.textContent?.startsWith("Packages, versions"))!.textContent;
    act(() => root.unmount());
    container.remove();
    return { names, summary };
  };
  try {
    const macos = await render("macos");
    expect(macos.names).toEqual(expect.arrayContaining(["shared-crate", "untagged-crate", "objc2"]));
    for (const hidden of ["zbus", "webkit2gtk", "windows-sys", "single-instance"]) expect(macos.names).not.toContain(hidden);
    expect(macos.summary).toContain("(3)");
    const windows = await render("windows");
    expect(windows.names).toEqual(["shared-crate", "untagged-crate", "windows-sys", "single-instance"]);
    expect(windows.summary).toContain("(4)");
    const linux = await render("linux");
    expect(linux.names).toEqual(["shared-crate", "untagged-crate", "zbus", "webkit2gtk", "single-instance"]);
    expect(linux.summary).toContain("(5)");
  } finally {
    vi.unstubAllGlobals();
  }
});

it("shows the Linux beta version as 1.2.3β and macOS and Windows versions unchanged", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("__ABOUT_PROVENANCE__", { components: [], licenseTexts: { LICENSE: "Apache License" } });
  const versionLine = async (platform: "macos" | "windows" | "linux") => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<AboutWindow version="1.2.3" buildStamp="test" platform={platform} onCopy={async () => {}} />));
    const text = container.querySelector(".about-version")?.textContent;
    act(() => root.unmount());
    container.remove();
    return text;
  };
  try {
    expect(await versionLine("linux")).toBe("Version 1.2.3β Build test");
    expect(await versionLine("macos")).toBe("Version 1.2.3 Build test");
    expect(await versionLine("windows")).toBe("Version 1.2.3 Build test");
  } finally {
    vi.unstubAllGlobals();
  }
});

it("keeps every link target; standalone links and @handles underline only on hover or focus, inline prose links stay underlined", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("__ABOUT_PROVENANCE__", {
    components: [{ name: "example-package", version: "1.0.0", license: "MIT", holders: ["see license"], purpose: "Test package",
      sourceUrl: "https://example.com/package", licenseText: "LICENSE" }],
    licenseTexts: { LICENSE: "Apache License" }
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<AboutWindow version="1.2.3" buildStamp="test" platform="macos" onCopy={async () => {}} onClose={() => {}} />));
    const repository = "https://github.com/jgassens/ChemDraft";
    const links = [...container.querySelectorAll("a")];
    expect(links.map(link => link.getAttribute("href"))).toEqual([
      "#about-section-0", "#about-section-1", "#about-section-2",
      "https://chemdraft.ai", repository,
      ...contributors.filter(({ handle }) => handle).map(({ handle }) => "https://github.com/" + handle),
      ...testers.handles.map(handle => "https://github.com/" + handle),
      repository + "/blob/main/NOTICE", repository + "/blob/main/docs/architecture/dependency-inventory.md",
      "https://example.com/package"
    ]);
    // External links still open the way they always have: a new window the native host sends to the system browser.
    for (const link of links.filter(link => link.getAttribute("href")!.startsWith("https://"))) {
      expect(link.target).toBe("_blank");
      expect(link.rel).toBe("noopener noreferrer");
    }
    // Accessible names are the visible text; every link and button stays in the tab order.
    const aboutLinks = [...container.querySelectorAll(".about-links a")].map(link => link.textContent);
    expect(aboutLinks).toEqual(["ChemDraft website", "GitHub repository", "Full notices and license texts", "Dependency inventory"]);
    for (const element of [...links, ...container.querySelectorAll("button")]) {
      expect(element.getAttribute("tabindex")).toBeNull();
      expect(element.getAttribute("aria-hidden")).toBeNull();
    }
    for (const button of container.querySelectorAll("button")) expect(button.type).toBe("button");
    expect([...container.querySelectorAll(".about-links button")].map(button => button.textContent)).toEqual(["Read the license"]);
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }

  const css = readFileSync("apps/desktop/src/about/about.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selectors: selector!.replace(/^[\s\S]*\{/, "").split(",").map(part => part.trim()), body: body!
  }));
  const ruleFor = (selector: string, property: RegExp) => rules.filter(rule => rule.selectors.includes(selector) && property.test(rule.body)).at(-1);
  // The default link rule underlines, so a link inside running prose is never told apart by color alone.
  const linkRule = ruleFor(".about-window a", /text-decoration/)!;
  expect(linkRule.body).toMatch(/text-decoration:\s*underline/);
  expect(linkRule.body).toMatch(/color:\s*#154c8f/);
  // Standalone links, @handles included, drop the underline until hover or keyboard focus.
  const standalone = [".about-window nav a", ".about-window .about-links a", ".about-window .about-links button",
    ".about-window .about-handle", ".about-window h3 a"];
  const plain = rules.find(rule => /text-decoration:\s*none/.test(rule.body))!;
  expect(plain.selectors.sort()).toEqual([...standalone].sort());
  expect(plain.selectors).not.toContain(".about-window a");
  const hovered = rules.filter(rule => /text-decoration:\s*underline/.test(rule.body) && rule !== linkRule);
  expect(hovered).toHaveLength(1);
  expect(hovered[0]!.selectors.sort()).toEqual(standalone.flatMap(selector => [selector + ":hover", selector + ":focus-visible"]).sort());
  // A handle is marked at rest without color: the leading '@' and a medium weight.
  expect(ruleFor(".about-window .about-handle", /font-weight/)!.body).toMatch(/font-weight:\s*500/);
  // Every rendered @handle (contributors beside their names, and the tester list) carries the handle look, and any
  // other link that is not standalone (a link in running prose) falls back to the underlined default.
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("__ABOUT_PROVENANCE__", {
    components: [{ name: "example-package", version: "1.0.0", license: "MIT", holders: ["see license"], purpose: "Test package",
      sourceUrl: "https://example.com/package" }],
    licenseTexts: {}
  });
  const rendered = document.createElement("div");
  document.body.append(rendered);
  const renderedRoot = createRoot(rendered);
  try {
    await act(async () => renderedRoot.render(<AboutWindow version="1.2.3" buildStamp="test" platform="macos" onCopy={async () => {}} />));
    const handleLinks = [...rendered.querySelectorAll("a")].filter(link => link.textContent!.startsWith("@"));
    expect(handleLinks).toHaveLength(contributors.filter(({ handle }) => handle).length + testers.handles.length);
    for (const link of handleLinks) {
      expect(link.classList.contains("about-handle")).toBe(true);
      expect(link.getAttribute("href")).toBe("https://github.com/" + link.textContent!.slice(1));
    }
    const contributorHandle = contributors.find(({ handle }) => handle)?.handle;
    if (contributorHandle) {
      const link = rendered.querySelector('.about-credits a[href="https://github.com/' + contributorHandle + '"]')!;
      expect(link.previousElementSibling?.tagName).toBe("STRONG");
      expect(link.matches(".about-handle")).toBe(true);
    }
    // Inline prose links: none today. Any that appear must not be caught by a standalone selector, so they keep
    // the underline from the default rule.
    const inProse = [...rendered.querySelectorAll(".about-window p a")]
      .filter(link => !link.closest(".about-links"));
    for (const link of inProse) expect(standalone.some(selector => link.matches(selector))).toBe(false);
  } finally {
    act(() => renderedRoot.unmount());
    rendered.remove();
    vi.unstubAllGlobals();
  }
  // Same look as the Guided Tour link (tour/TourForm.css .guided-tour-url a).
  const tour = readFileSync("apps/desktop/src/tour/TourForm.css", "utf8");
  expect(tour).toMatch(/\.guided-tour-url a \{\s*color: #154c8f;/);
  expect(tour).toMatch(/\.guided-tour-url a:focus-visible \{\s*outline: 2px solid #154c8f;\s*outline-offset: 2px;\s*border-radius: 2px;/);
  const focusRule = ruleFor(".about-window a:focus-visible", /outline:/)!;
  expect(focusRule.body).toMatch(/outline:\s*2px solid var\(--cd-accent\)/);
  expect(focusRule.body).toMatch(/box-shadow:\s*var\(--cd-focus-ring\)/);
  expect(focusRule.body).toMatch(/outline-offset:\s*2px/);
  expect(linkRule.body).toMatch(/border-radius:\s*2px/);
  // Dark scheme falls back to the system link color.
  expect(css).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{\s*\.about-window a,\s*\.about-window \.about-links button\s*\{\s*color: LinkText;/);
});

it.each([
  ["Linux desktop browser", "Linux x86_64", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"],
  ["iPhone", "iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"]
])("the browser About on a %s shows and copies the plain version, never the Linux beta label", async (_name, platform, userAgent) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("__ABOUT_PROVENANCE__", { components: [], licenseTexts: { LICENSE: "Apache License" } });
  vi.stubGlobal("__BUILD_STAMP__", "web-stamp");
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<BrowserAboutWindow />));
    expect(container.querySelector(".about-version")?.textContent).toBe("Version " + packageInfo.version + " Build web-stamp");
    expect(container.textContent).not.toContain("β");
    const copy = [...container.querySelectorAll("button")].find(button => button.textContent === "Copy Version")!;
    await act(async () => copy.click());
    expect(writeText).toHaveBeenCalledWith("ChemDraft " + packageInfo.version + " (build web-stamp)");
  } finally {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(navigator, "clipboard");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
