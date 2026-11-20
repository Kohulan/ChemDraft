import { describe, expect, it } from "vitest";
import { buildAboutProvenance, readAboutSource } from "./buildProvenance";

describe("About provenance", () => {
  const provenance = buildAboutProvenance();
  const displayed = new Set(provenance.components.map(component => component.name));

  it("covers every row of the dependency inventory and every NOTICE component entry", () => {
    const source = readAboutSource("docs/architecture/dependency-inventory.md");
    const names = [...source.matchAll(/^\| ([^|]+?) \|/gm)].map(match => match[1]!.replace(/[\x60*]/g, ""))
      .filter(name => !["Component", "Package", "---"].includes(name));
    expect([...provenance.inventoryCoverage.keys()]).toEqual(names);

    const notice = readAboutSource("NOTICE");
    // Component paragraphs start with a heading, then indent the details.
    const paragraphs = notice.split(/\n{2,}/);
    const headings = paragraphs.flatMap(paragraph => {
      if (!/^\S/.test(paragraph) || /^(?:APPENDIX A\.|A\.\d )/.test(paragraph)) return [];
      const lines = paragraph.split("\n");
      const detailStart = lines.findIndex(line => line.startsWith("  "));
      return detailStart > 0 ? [lines.slice(0, detailStart).join(" ")] : [];
    });
    // The network list, shaded JAR table, and datasets have their own heading formats.
    const beforeAppendix = notice.split("\nAPPENDIX A.")[0]!;
    const network = paragraphs.find(paragraph => paragraph.startsWith("Network transport and diagnostics"))!;
    const networkHeadings = [...network.matchAll(/^ {2}(\S+ \d[^\s:]*)/gm)].map(match => match[1]!);
    const jarHeadings = [...beforeAppendix.matchAll(/^ {4}(\S[^\n]*?) {2,}\S/gm)].map(match => match[1]!);
    const dataSection = beforeAppendix.split("\nData under separate terms\n")[1]!;
    const dataHeadings = [...dataSection.matchAll(/\n\n {2}(\S[^\n]*)/g)].map(match => match[1]!);
    expect([...provenance.noticeCoverage.keys()]).toEqual([
      ...headings, ...networkHeadings, ...jarHeadings, ...dataHeadings
    ]);
    for (const disposition of provenance.inventoryCoverage.values()) {
      expect(displayed.has(disposition) ||
        ["Development or build tooling", "Distributed separately", "Linkage remains unconfirmed"].includes(disposition)).toBe(true);
    }
    for (const disposition of provenance.noticeCoverage.values()) {
      expect(displayed.has(disposition) ||
        ["Group heading", "Downloaded separately", "Unused by the shipped model"].includes(disposition)).toBe(true);
    }

    expect(provenance.noticeCoverage.get("Apache Commons CLI (1.11.0)")).toBe("Apache Commons CLI (1.11.0)");
    expect(provenance.npmCoverage.has("@tanstack/react-hotkeys")).toBe(true);
    expect(provenance.npmCoverage.has("svg2pdf.js")).toBe(true);
    expect(displayed.has("nmrshiftdb2-derived reference database")).toBe(false);
  });

  it("resolves build metadata, legal caveats, and local license texts", () => {
    expect(provenance.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Octet Draw", license: expect.stringContaining("Sam Ellis") }),
      expect.objectContaining({ name: "RDKit MinimalLib WASM (vendored)", version: "Release_2026_03_3" }),
      expect.objectContaining({ name: "IsoSpec WASM (vendored)", version: "2.3.5" }),
      expect.objectContaining({ name: "indigo-ketcher", version: "1.40.0" }),
      expect.objectContaining({ name: "OPSIN (vendored JAR + bundled JRE)", version: "2.9.0" }),
      expect.objectContaining({ name: "InChI (inside the RDKit MinimalLib WASM)", version: "1.07.3", license: expect.stringContaining("unconfirmed") }),
      expect.objectContaining({ name: "avogadrolibs (Avogadro Core + Calc)", version: "416651ddaef33a4e20392392e7c0b505d446491b" })
    ]));
    for (const component of provenance.components) {
      expect(component.purpose).toBeTruthy();
      expect(new URL(component.sourceUrl).protocol).toBe("https:");
      if (component.licenseText) expect(provenance.licenseTexts[component.licenseText]).toBeTruthy();
    }
    expect(provenance.components.map(c => [c.name, c.purpose].join(" ")).join("\n"))
      .not.toMatch(/chemdraw|marvin(?:sketch)?|isischem|isis\/draw|chemsketch|chemwindow/i);
    expect(provenance.licenseTexts.LICENSE).toBe(readAboutSource("LICENSE"));
    expect(provenance.licenseTexts["packages/export-engine/src/fonts/LICENSE_PATRICK_HAND.txt"]).toBeTruthy();
  });
});
