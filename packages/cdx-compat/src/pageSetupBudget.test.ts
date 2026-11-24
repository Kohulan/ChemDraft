import { describe, expect, it } from "vitest";
import type { DocumentPage } from "@chemdraft/chem-core";
import { exportDocumentToCdxml, openChemDraftPayload } from "./index";
import { defaultCdxmlLimits, withCdxmlLimitsForTesting } from "./cdxmlLimits";

// Kimi (#442, pre-existing): every imported page stored its own copy of the root page setup
// (cdxmlRootPageAttributes), whose Header, Footer, MacPrintInfo and WinPrintInfo have no length
// limit, so a crafted file of many pages and one long attribute saved (pages x length) of native
// JSON on autosave. Copies now share a document-wide character budget; past it a page keeps only
// its grid attributes and names what it left out. Sizes are counted, never timed; the budget is
// lowered from 1,048,576 to 10,000 characters so the fixture stays small.

const plain = { embedNativePayload: false };
const header = "H".repeat(3_000);
const printInfo = "0A".repeat(500);
const source = (pages: number) =>
  `<CDXML Header="${header}" WinPrintInfo="${printInfo}" PrintMargins="36 36 36 36">` +
  Array.from({ length: pages }, (_, i) => `<page id="${100 + i}" BoundingBox="0 0 540 720">` +
    `<t id="${200 + i}" p="40 ${60 + i}"><s font="3" size="10" face="0">p${i}</s></t></page>`).join("") + "</CDXML>";
const rootOf = (page: DocumentPage) => page.compatibility?.unknown.cdxmlRootPageAttributes as Record<string, string>;
const storedRootChars = (pages: readonly DocumentPage[]) => pages.reduce((sum, page) => sum + JSON.stringify(rootOf(page) ?? {}).length, 0);
const budget = { rootPageAttributeCopyChars: 10_000 };

describe("root page setup copies (#442)", () => {
  it("pins the production budget", () => {
    expect(defaultCdxmlLimits.rootPageAttributeCopyChars).toBe(1_048_576);
  });

  it("stores the root page setup within a document-wide budget, so native JSON grows linearly with pages", () => withCdxmlLimitsForTesting(budget, () => {
    const [small, large] = [10, 20].map(count => {
      const opened = openChemDraftPayload(source(count));
      expect(opened.warnings.map(w => w.code)).not.toContain("cdxml.page_setup_not_kept");
      const pages = opened.document!.pages;
      expect(pages).toHaveLength(count);
      // The first page (and the second, within the budget) keeps the whole set; export writes it from the first.
      expect(rootOf(pages[0])).toEqual({ Header: header, WinPrintInfo: printInfo, PrintMargins: "36 36 36 36" });
      expect(rootOf(pages[1])).toEqual(rootOf(pages[0]));
      // Past it a page keeps its grid attribute and names what it left out.
      for (const page of pages.slice(2)) {
        expect(rootOf(page)).toEqual({ PrintMargins: "36 36 36 36" });
        expect(page.compatibility?.unknown.cdxmlRootPageAttributesOmitted).toEqual(["Header", "WinPrintInfo"]);
      }
      const stored = storedRootChars(pages);
      // Before the budget every page stored ~4,000 characters (20 pages: ~80,000).
      expect(stored).toBeLessThanOrEqual(budget.rootPageAttributeCopyChars + 64 * count);
      return { stored, json: JSON.stringify(opened.document).length };
    });
    // Ten more pages add a bounded amount per page, not another copy of the setup each.
    expect(large.stored - small.stored).toBeLessThanOrEqual(10 * 64);
    expect((large.json - small.json) / 10).toBeLessThan(header.length);
  }));

  it("saves the root page setup unchanged, and warns once if the pages that kept it were deleted", () => withCdxmlLimitsForTesting(budget, () => {
    const opened = openChemDraftPayload(source(5));
    const saved = exportDocumentToCdxml(opened.document!, plain);
    expect(saved.contents).toContain(`Header="${header}"`);
    expect(saved.warnings.map(w => w.code)).not.toContain("cdxml.page_setup_not_kept");
    const document = opened.document!;
    document.pages = document.pages.slice(2);
    const after = exportDocumentToCdxml(document, plain);
    expect(after.contents).not.toContain("Header=");
    expect(after.warnings.filter(w => w.code === "cdxml.page_setup_not_kept").map(w => w.message)).toEqual([
      "CDXML export: the source file's document page settings (Header, WinPrintInfo) were stored only with its first pages, " +
      `since a copy on every page would have exceeded 10000 characters, and page ${document.pages[0].id} is now the first page; they are not written.`
    ]);
  }));

  it("keeps a real file's page setup on every page, so deleting its first page still saves it", () => {
    // Production budget; a ChemDraw-sized WinPrintInfo (a DEVMODE, ~1 KB as hex) over three pages.
    const opened = openChemDraftPayload(source(3));
    const pages = opened.document!.pages;
    for (const page of pages) {
      expect(rootOf(page)).toEqual({ Header: header, WinPrintInfo: printInfo, PrintMargins: "36 36 36 36" });
      expect(page.compatibility?.unknown.cdxmlRootPageAttributesOmitted).toBeUndefined();
    }
    const saved = exportDocumentToCdxml(opened.document!, plain);
    expect(exportDocumentToCdxml(openChemDraftPayload(saved.contents).document!, plain).contents).toBe(saved.contents);
    opened.document!.pages = pages.slice(1);
    const after = exportDocumentToCdxml(opened.document!, plain);
    expect(after.contents).toContain(`Header="${header}"`);
    expect(after.warnings.map(w => w.code)).not.toContain("cdxml.page_setup_not_kept");
  });
});
