import { describe, expect, it } from "vitest";
import type { DocumentObject, DocumentPage, ElectronMarkObject } from "@chemdraft/chem-core";
import { nativeChargeMarkSizePx, nativeChargePlacementPointForAtom, nativeRadicalPlacementPointForAtom, transformPointForObject } from "@chemdraft/layout-engine";
import { openChemDraftPayload } from "./index";
import { isStandardAtomRadicalMark, standardRadicalMarkPageIndex } from "./standardRadicalMarks";

// Save As (and the session autosave right after a file opens) asks, for every radical dot, whether it
// is the default dot its atom's Radical attribute stands for. That check filtered every page object
// once per dot, and handed placement the whole page or a slice of it: (dots x objects) on a crafted
// page. It now reads a page index built once.

/** Deterministic pseudo-random numbers, so every run checks the same pages. */
function random(seed: number): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
}

/** Single-atom or two-atom fragments with doublets, triplets, charges and attached lone pairs. */
function cdxml(count: number, r: () => number): string {
  const parts = Array.from({ length: count }, (_, index) => {
    const x = 40 + (index % 20) * 30, y = 40 + Math.floor(index / 20) * 30, node = 1000 + index;
    const radical = r() < 0.25 ? "" : r() < 0.6 ? ' Radical="Doublet"' : ' Radical="Triplet"';
    const charge = r() < 0.2 ? ' Charge="1"' : "";
    const second = r() < 0.4 ? `<n id="${3000 + index}" Element="6" p="${x + 20} ${y + 8}"/><b id="${4000 + index}" B="${node}" E="${3000 + index}"/>` : "";
    const lonePair = r() < 0.3 ? `<graphic id="${9000 + index}" GraphicType="Symbol" SymbolType="LonePair" ` +
      `BoundingBox="${x} ${y - 7} ${x + 3} ${y - 7}"><represent object="${node}" attribute="Radical"/></graphic>` : "";
    return `<fragment id="${5000 + index}"><n id="${node}" Element="${r() < 0.5 ? 8 : 6}" p="${x} ${y}"${radical}${charge}/>${second}</fragment>${lonePair}`;
  });
  return `<CDXML><page>${parts.join("")}</page></CDXML>`;
}

/**
 * An opened page whose imported dots are varied the ways a document reaches Save As: untouched, with
 * legacy placement metadata (no offsets), as atom-tool dots (no metadata), or moved.
 */
function page(count: number, seed: number): DocumentPage {
  const r = random(seed);
  const opened = structuredClone(openChemDraftPayload(cdxml(count, r)).document!.pages[0]);
  for (const object of opened.objects) if (object.type === "electron-mark" && object.markKind === "radical-dot") {
    const variant = r();
    if (variant < 0.2) delete object.compatibility;
    else if (variant < 0.35) {
      const placement = object.compatibility!.unknown.cdxmlRadicalMarkPlacement as Record<string, unknown>;
      delete placement.offsetX;
      delete placement.offsetY;
    } else if (variant < 0.45) object.x += 3;
  }
  return opened;
}

/** The check as it was before the page index: whole-page filters and slices for every dot. */
function referenceIsStandard(mark: ElectronMarkObject, page: DocumentPage, objectsById: ReadonlyMap<string, DocumentObject>): boolean {
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  if (mark.markKind !== "radical-dot" || mark.anchor.kind !== "atom"
      || mark.style.source !== "chemdraft-native-charge"
      || Object.entries(mark.style).some(([key, value]) => key !== "source" && value !== undefined)
      || mark.width !== nativeChargeMarkSizePx || mark.height !== nativeChargeMarkSizePx || mark.rotation !== 0) return false;
  const { objectId, atomId } = mark.anchor;
  const molecule = objectId && objectsById.get(objectId);
  if (!molecule || molecule.type !== "molecule") return false;
  const atom = molecule.atoms.find(atom => atom.id === atomId);
  if (!atom) return false;
  const imported = mark.compatibility?.unknown.cdxmlRadicalMarkPlacement;
  if (isRecord(imported)) {
    if (imported.objectId !== objectId || imported.atomId !== atomId) return false;
    if (typeof imported.offsetX === "number" && typeof imported.offsetY === "number") {
      const atomPoint = transformPointForObject(molecule, atom);
      return Math.abs(mark.x - atomPoint.x - imported.offsetX) < 1e-8
        && Math.abs(mark.y - atomPoint.y - imported.offsetY) < 1e-8;
    }
  }
  if (!isRecord(imported) && atom.markRadicals !== 1 && atom.markRadicals !== 2) return false;
  const carried = page.objects.filter(object => object.type === "electron-mark"
    && object.anchor.kind === "atom" && object.anchor.objectId === molecule.id && object.anchor.atomId === atom.id
    && (object.markKind === "radical-dot" || object.markKind === "charge" && object.radical)).length;
  if (!isRecord(imported) && carried !== atom.markRadicals) return false;
  const point = isRecord(imported)
    ? nativeChargePlacementPointForAtom(molecule, atom.id,
      page.objects.filter(object => object.type !== "electron-mark" || object.markKind === "charge"), page.width, page.height)
    : nativeRadicalPlacementPointForAtom(molecule, atom.id,
      page.objects.slice(0, page.objects.indexOf(mark)), page.width, page.height);
  if (!point) return false;
  const size = nativeChargeMarkSizePx;
  const x = Math.max(0, Math.min(point.x - size / 2, page.width - size));
  const y = Math.max(0, Math.min(point.y - size / 2, page.height - size));
  return Math.abs(mark.x - x) < 1e-8 && Math.abs(mark.y - y) < 1e-8;
}

function decisions(page: DocumentPage, check: "indexed" | "reference"): boolean[] {
  const objectsById = new Map(page.objects.map(object => [object.id, object]));
  let index: ReturnType<typeof standardRadicalMarkPageIndex> | undefined;
  return page.objects.filter((object): object is ElectronMarkObject => object.type === "electron-mark").map(mark => check === "indexed"
    ? isStandardAtomRadicalMark(mark, page, objectsById, () => index ??= standardRadicalMarkPageIndex(page))
    : referenceIsStandard(mark, page, objectsById));
}

describe("standard radical dots on Save As (#442 follow-up)", () => {
  it("decides every dot exactly as the whole-page check did", () => {
    let standard = 0, other = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const opened = page(30, seed);
      const expected = decisions(opened, "reference");
      expect(decisions(opened, "indexed")).toEqual(expected);
      standard += expected.filter(Boolean).length;
      other += expected.filter(value => !value).length;
    }
    // Both outcomes, through every path (offsets, legacy slot, atom-tool placement), are exercised.
    expect(standard).toBeGreaterThan(100);
    expect(other).toBeGreaterThan(100);
  });

  it("reads the page's objects a number of times linear in objects", () => {
    const reads = (count: number, check: "indexed" | "reference") => {
      const opened = page(count, 3);
      let gets = 0;
      opened.objects = opened.objects.map(object => new Proxy(object, {
        get(target, key, receiver) { gets++; return Reflect.get(target, key, receiver) as unknown; }
      }) as DocumentObject);
      decisions(opened, check);
      return gets;
    };
    // The reference is quadratic, so the counter is shown to detect it.
    expect(reads(80, "reference") / reads(40, "reference")).toBeGreaterThan(3.2);
    expect(reads(80, "indexed") / reads(40, "indexed")).toBeLessThan(2.5);
  });

  it("looks atoms up by id: one molecule of N atoms that each carry a dot costs linear atom reads", () => {
    const reads = (count: number, check: "indexed" | "reference") => {
      const atoms = Array.from({ length: count }, (_, index) =>
        `<n id="${1000 + index}" Element="8" p="${40 + (index % 20) * 30} ${40 + Math.floor(index / 20) * 30}" Radical="Doublet"/>`).join("");
      const opened = structuredClone(openChemDraftPayload(`<CDXML><page><fragment id="5000">${atoms}</fragment></page></CDXML>`).document!.pages[0]);
      const molecules = opened.objects.filter(object => object.type === "molecule");
      expect(molecules).toHaveLength(1);
      let gets = 0;
      const molecule = molecules[0];
      molecule.atoms = new Proxy(molecule.atoms, {
        get(target, key, receiver) { gets++; return Reflect.get(target, key, receiver) as unknown; }
      });
      const dots = opened.objects.filter(object => object.type === "electron-mark" && object.markKind === "radical-dot");
      expect(dots).toHaveLength(count);
      const result = decisions(opened, check);
      expect(result.every(Boolean)).toBe(true);
      return gets;
    };
    expect(reads(80, "reference") / reads(40, "reference")).toBeGreaterThan(3.2);
    expect(reads(80, "indexed") / reads(40, "indexed")).toBeLessThan(2.5);
  });
});
