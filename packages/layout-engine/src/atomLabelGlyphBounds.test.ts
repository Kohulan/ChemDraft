// The collision box must enclose the reference ink for each declared label font class.
// Ink comes from the public Adobe core-14 AFM metrics (Helvetica, Courier, regular and bold), each
// entry "char:advance,llx,lly,urx,ury" in 1/1000 em, placed as SVG text draws a run: baseline at
// run.y + 0.35 em, start/middle/end anchored by the font's own advance.

import { describe, expect, it } from "vitest";
import { DefaultNativeDrawingStyle, type MoleculeAtom, type NativeDrawingStyle } from "@chemdraft/chem-core";

import { atomLabelGlyphBounds, atomLabelLayout, type AtomLabelPlan } from "./index";
import { atomLabelReferenceInk, type AtomLabelReferenceFont } from "./atomLabelInk.fixture";

const SANS_STACKS = ["Arial, Helvetica, sans-serif", "Helvetica", "Arial", "'Helvetica', sans-serif", "sans-serif"];
const MONO_STACKS = ["Courier New, Courier, monospace", "Courier", "'Courier New', monospace"];
const FOREIGN_STACKS = ["Times New Roman, Times, serif", "Georgia, serif", "Menlo", "Arial, Georgia, serif",
  "Courier New, Arial, sans-serif", "system-ui", ""];

const atom: MoleculeAtom = { id: "a", element: "C", x: 0, y: 0, formalCharge: 0 };

function planFor(label: string, style: Partial<NativeDrawingStyle>, anchor?: { side: "start" | "end"; length: number }): AtomLabelPlan {
  const drawingStyle: NativeDrawingStyle = { ...DefaultNativeDrawingStyle, ...style };
  const layout = atomLabelLayout(label, drawingStyle, anchor);
  return { atom, label, ...(anchor ? { labelAnchor: anchor } : {}), anchor: { x: 0, y: 0 }, anchorOffset: { x: 0, y: 0 },
    layout, drawingStyle, color: drawingStyle.atomLabelColor, backgroundColor: drawingStyle.atomLabelBackgroundColor,
    backgroundVisible: false, fontFamily: drawingStyle.atomLabelFontFamily, fontSizePx: drawingStyle.atomLabelFontSizePx,
    fontWeight: drawingStyle.atomLabelFontWeight, fontStyle: drawingStyle.atomLabelFontStyle };
}

function expectEncloses(plan: AtomLabelPlan, font: AtomLabelReferenceFont, shear = 0): void {
  const box = atomLabelGlyphBounds(plan), ink = atomLabelReferenceInk(plan, font, shear), eps = 1e-9;
  const where = JSON.stringify({ label: plan.label, font, box, ink });
  expect(box.x, where).toBeLessThanOrEqual(ink.left + eps);
  expect(box.x + box.width, where).toBeGreaterThanOrEqual(ink.right - eps);
  expect(box.y, where).toBeLessThanOrEqual(ink.top + eps);
  expect(box.y + box.height, where).toBeGreaterThanOrEqual(ink.bottom - eps);
}

// Labels cover parentheses and brackets, a Q, a lowercase descender, commas, charges, isotopes,
// subscripts and superscripts. Upper-case/digit labels also run in bold, whose advance the layout
// scales from the regular one.
const LABELS = ["OH", "NH2", "I", "Q", "O", "H", "N(CH3)2", "(CH2)3", "[Fe]", "[Cu(NH3)4]2+", "C(O)Q", "CH3,", "S;O",
  "O-", "NH4+", "N2+", "O2-", "Mg2+", "13C", "2H", "Cl-", "OMe", "tBu", "Cp", "Pyg", "Q-", "P{O}", "C/O", "C_6"];
const CAPS_LABELS = LABELS.filter(label => !/[a-z]/.test(label.replace(/^\d+/, "")) || /^\[Fe\]$/.test(label));
const ANCHORS = [undefined, { side: "start" as const, length: 1 }, { side: "end" as const, length: 1 }];

describe("atomLabelGlyphBounds encloses the ink of the label font", () => {
  it.each(SANS_STACKS)("Helvetica/Arial stack %s: every label, anchor and size", (fontFamily) => {
    for (const label of LABELS) for (const anchor of ANCHORS) for (const atomLabelFontSizePx of [10, 15, 23]) {
      if (/^[^a-z]*$/.test(label) || anchor === undefined) {
        // An anchored layout needs the anchor characters in a normal-script run.
        expectEncloses(planFor(label, { atomLabelFontFamily: fontFamily, atomLabelFontSizePx }, anchor), "helvetica");
      }
    }
  });

  it("covers bold Helvetica ink for upper-case labels", () => {
    for (const label of CAPS_LABELS) {
      expectEncloses(planFor(label, { atomLabelFontWeight: 700, atomLabelFontSizePx: 18 }), "helveticaBold");
    }
  });

  it("covers slanted Helvetica ink (real and synthetic italics)", () => {
    for (const label of LABELS) {
      expectEncloses(planFor(label, { atomLabelFontStyle: "italic", atomLabelFontSizePx: 16 }), "helvetica", 0.25);
    }
  });

  it.each(MONO_STACKS)("monospace stack %s: every label at Courier's 0.6 em advance", (fontFamily) => {
    for (const label of LABELS) for (const anchor of ANCHORS) for (const atomLabelFontSizePx of [10, 15, 23]) {
      if (/^[^a-z]*$/.test(label) || anchor === undefined) {
        expectEncloses(planFor(label, { atomLabelFontFamily: fontFamily, atomLabelFontSizePx }, anchor), "courier");
      }
    }
    for (const label of CAPS_LABELS) {
      expectEncloses(planFor(label, { atomLabelFontFamily: fontFamily, atomLabelFontWeight: 700 }), "courierBold");
    }
  });

  it("widens a monospace 'I' to its advance, where Helvetica's is under half as wide", () => {
    const courier = atomLabelGlyphBounds(planFor("I", { atomLabelFontFamily: "Courier New, Courier, monospace", atomLabelFontSizePx: 20 }));
    const helvetica = atomLabelGlyphBounds(planFor("I", { atomLabelFontSizePx: 20 }));
    expect(courier.width).toBeGreaterThanOrEqual(0.6 * 20);
    expect(helvetica.width).toBeLessThan(0.3 * 20);
  });

  it("keeps the run's text anchor when widening a monospace run", () => {
    const size = 20, family = "Courier New, Courier, monospace";
    const plan = planFor("MeO2C", { atomLabelFontFamily: family, atomLabelFontSizePx: size }, { side: "end", length: 1 });
    const box = atomLabelGlyphBounds(plan);
    const runs = plan.layout.runs;
    const anchored = runs.filter(run => run.textAnchor === "end")[0]!;
    expect(box.x + box.width).toBeGreaterThanOrEqual(anchored.x);
    expect(box.x).toBeLessThanOrEqual(anchored.x - anchored.text.length * 0.6 * size);
  });

  it("descends below the baseline for Q, brackets, parentheses and commas, and rises for brackets", () => {
    const size = 20;
    const baseline = (plan: AtomLabelPlan) => plan.layout.runs[0]!.y + 0.35 * size;
    for (const [label, descent, ascent] of [["Q", 0.138, 0.737], ["(", 0.208, 0.734], [")", 0.208, 0.734],
      ["[", 0.196, 0.722], ["]", 0.196, 0.722], ["{", 0.196, 0.722], [",", 0.168, 0.2], [";", 0.168, 0.5], ["/", 0.019, 0.737]] as const) {
      const plan = planFor(label, { atomLabelFontSizePx: size });
      const box = atomLabelGlyphBounds(plan);
      expect(box.y + box.height, label).toBeGreaterThanOrEqual(baseline(plan) + descent * size);
      expect(box.y, label).toBeLessThanOrEqual(baseline(plan) - ascent * size);
    }
  });

  it("encloses the plus and minus ink of a charge, and the isotope and subscript digits", () => {
    for (const label of ["N+", "O-", "N3+", "O2-", "13CH3", "H2O", "CO2H"]) {
      expectEncloses(planFor(label, { atomLabelFontSizePx: 20 }), "helvetica");
      expectEncloses(planFor(label, { atomLabelFontSizePx: 20, atomLabelFontFamily: "Courier" }), "courier");
    }
  });

  it("keeps the sans-serif glyph box inside the padded renderer bounds for ordinary labels", () => {
    for (const label of ["OH", "NH2", "CO2H", "O-", "NH4+", "N2+", "13C", "H2N", "I", "Cl"]) {
      for (const anchor of ANCHORS) {
        const plan = planFor(label, {}, anchor), box = atomLabelGlyphBounds(plan), bounds = plan.layout.bounds;
        expect(box.x, label).toBeGreaterThanOrEqual(bounds.x - 1e-9);
        expect(box.y, label).toBeGreaterThanOrEqual(bounds.y - 1e-9);
        expect(box.x + box.width, label).toBeLessThanOrEqual(bounds.x + bounds.width + 1e-9);
        expect(box.y + box.height, label).toBeLessThanOrEqual(bounds.y + bounds.height + 1e-9);
      }
    }
  });

  it.each(FOREIGN_STACKS)("an unknown font stack (%j) gets the padded renderer bounds", (fontFamily) => {
    for (const label of ["OH", "Q", "I", "N(CH3)2", "O2-"]) {
      const plan = planFor(label, { atomLabelFontFamily: fontFamily });
      expect(atomLabelGlyphBounds(plan)).toEqual(plan.layout.bounds);
    }
  });

  it.each(["La@C82", "\u0394H", "O\u2014H", "50%"])("a label with a character outside the metric tables (%j) gets the padded bounds", (label) => {
    const plan = planFor(label, {});
    expect(atomLabelGlyphBounds(plan)).toEqual(plan.layout.bounds);
  });

  it("treats a bare generic monospace as unknown but keeps the box when Courier is named first", () => {
    const bare = planFor("OH", { atomLabelFontFamily: "monospace" });
    expect(atomLabelGlyphBounds(bare)).toEqual(bare.layout.bounds);
    const named = planFor("OH", { atomLabelFontFamily: "Courier New, monospace" });
    expect(atomLabelGlyphBounds(named)).not.toEqual(named.layout.bounds);
  });
});
