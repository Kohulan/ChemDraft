import { afterEach, describe, expect, it, vi } from "vitest";
import { documentWindowTitle, LINUX_BETA_MARK, versionLabel } from "./appVersionLabel";

afterEach(() => { vi.restoreAllMocks(); });

describe("versionLabel", () => {
  it("names a Linux beta after its parent version plus β", () => {
    expect(LINUX_BETA_MARK).toBe("β");
    expect(versionLabel("1.2.3", "linux")).toBe("1.2.3β");
  });

  it.each(["macos", "windows"] as const)("shows the version unchanged on %s", platform => {
    expect(versionLabel("1.2.3", platform)).toBe("1.2.3");
  });

  it.each([["MacIntel", "1.2.3"], ["Win32", "1.2.3"], ["Linux x86_64", "1.2.3β"]])(
    "defaults to the detected platform (%s)", (navigatorPlatform, expected) => {
      vi.spyOn(globalThis.navigator, "platform", "get").mockReturnValue(navigatorPlatform);
      expect(versionLabel("1.2.3")).toBe(expected);
    });
});

describe("documentWindowTitle", () => {
  it.each(["macos", "windows", "web"] as const)("keeps the plain product name on %s", platform => {
    expect(documentWindowTitle("Untitled", false, "", "1.2.3", platform)).toBe("Untitled — ChemDraft");
    expect(documentWindowTitle("A.chemdraft", true, "tree [branch]", "1.2.3", platform)).toBe("A.chemdraft • — ChemDraft — tree [branch]");
  });

  it("names the Linux beta version in the title", () => {
    expect(documentWindowTitle("Untitled", false, "", "1.2.3", "linux")).toBe("Untitled — ChemDraft 1.2.3β");
    expect(documentWindowTitle("A.chemdraft", true, "tree [branch]", "1.2.3", "linux")).toBe("A.chemdraft • — ChemDraft 1.2.3β — tree [branch]");
  });
});
