// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyPatch, createEmptyDocument, DocumentObjectSchema, type ChemDraftDocument } from "@chemdraft/chem-core";
import type { AcceptProposedPatchOptions, PluginHost, QueuedProposedPatch } from "@chemdraft/plugin-host";
import { previewAcceptedPluginProposal } from "./applyPluginDocumentPatch";
import type { PluginProposalReviewItem } from "./panelBridge";
import { acceptedProposalMessage, PatchReviewList, proposalReviewItem } from "./PatchReviewTray";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

function unmount(): void {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
}

afterEach(unmount);

function render(proposals: readonly PluginProposalReviewItem[]): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      createElement(PatchReviewList, {
        proposals,
        onAccept: vi.fn(),
        onReject: vi.fn()
      })
    )
  );
}

function recognitionProposal(overrides: Partial<PluginProposalReviewItem> = {}): PluginProposalReviewItem {
  return {
    id: "proposal-1",
    pluginId: "org.chemdraft.ocsr.molscribe",
    pluginName: "MolScribe OCSR",
    reason: "Recognized structure from the selected image.",
    warnings: [],
    recognition: {
      sourceImageRef: "data:image/png;base64,AAAA",
      proposedMolfile: "mock molfile",
      confidenceTier: "medium"
    },
    ...overrides
  };
}

function nonRecognitionProposal(overrides: Partial<PluginProposalReviewItem> = {}): PluginProposalReviewItem {
  return {
    id: "proposal-2",
    pluginId: "org.chemdraft.nmr.predictor",
    pluginName: "NMR Shift Predictor",
    reason: "Predicted shifts for the selected molecule.",
    warnings: [],
    ...overrides
  };
}

describe("PatchReviewList experimental recognition notice", () => {
  it("names each proposal's document when the desktop supplies tab labels", () => {
    render([
      recognitionProposal({ documentName: "Source.chemdraft" }),
      nonRecognitionProposal({ documentName: "Other.chemdraft" })
    ]);
    expect(document.querySelector('[data-proposal-id="proposal-1"] .patch-review-document')?.textContent)
      .toBe("Document: Source.chemdraft");
    expect(document.querySelector('[data-proposal-id="proposal-2"] .patch-review-document')?.textContent)
      .toBe("Document: Other.chemdraft");
  });

  it("shows the experimental notice on a recognition proposal", () => {
    render([recognitionProposal()]);
    const item = document.querySelector('[data-proposal-id="proposal-1"]');
    const notice = item?.querySelector('[data-testid="recognition-experimental-note"]');
    expect(notice?.textContent).toContain("Experimental recognition");
    expect(notice?.textContent).toContain("check every atom and bond");
  });

  it("does not show the notice on a non-recognition proposal", () => {
    render([nonRecognitionProposal()]);
    const item = document.querySelector('[data-proposal-id="proposal-2"]');
    expect(item?.querySelector('[data-testid="recognition-experimental-note"]')).toBeNull();
  });

  it("does not add a click before Accept/Reject remain reachable", () => {
    const onAccept = vi.fn();
    render([recognitionProposal()]);
    act(() =>
      root!.render(
        createElement(PatchReviewList, {
          proposals: [recognitionProposal()],
          onAccept,
          onReject: vi.fn()
        })
      )
    );
    const acceptButton = document.querySelector<HTMLButtonElement>(
      '[data-proposal-id="proposal-1"] button'
    );
    act(() => acceptButton!.click());
    expect(onAccept).toHaveBeenCalledWith("proposal-1");
  });
});

describe("A proposal stating a hydrogen count an H atom cannot carry", () => {
  type Atom = { id: string; element: string; x: number; y: number; hydrogenCount?: number };
  type Bond = { id: string; fromAtomId: string; toAtomId: string; order: "single" };
  const carbon: Atom = { id: "c", element: "C", x: 0, y: 0 };
  const hydrogen: Atom = { id: "h", element: "H", x: 20, y: 0 };
  const carbonHydrogen: Bond = { id: "b", fromAtomId: "c", toAtomId: "h", order: "single" };
  const molecule = (atoms: Atom[], bonds: Bond[]) => ({ id: "m", type: "molecule", x: 0, y: 0, width: 20, height: 1, rotation: 0, style: {},
    structureFormat: "smiles", structure: "", superatoms: [], rGroups: [], atoms, bonds });

  const blank = createEmptyDocument();
  // The document an update proposal is accepted into: molecule m, a C bonded to an H stating nothing.
  const withMolecule = applyPatch(blank, { op: "addObject", pageId: blank.pages[0]!.id,
    object: DocumentObjectSchema.parse(molecule([carbon, hydrogen], [carbonHydrogen])) });

  const stated = (hydrogenCount: number | undefined): Atom =>
    ({ ...hydrogen, ...(hydrogenCount === undefined ? {} : { hydrogenCount }) });

  function queued(patch: unknown): QueuedProposedPatch {
    return {
      id: "proposal-h", pluginId: "org.example.test", status: "pending", createdAt: "2026-11-22T00:00:00.000Z",
      proposal: { patch, reason: "Edits a molecule.", warnings: [], requiresUserApproval: true }
    } as QueuedProposedPatch;
  }
  /** Inserts molecule m (into the blank document) whose H states `hydrogenCount`. */
  const added = (hydrogenCount: number | undefined) => ({
    source: blank,
    proposal: queued({ op: "addObject", pageId: "page-1", object: molecule([carbon, stated(hydrogenCount)], [carbonHydrogen]) })
  });
  /** Updates m so its H states 1 and nothing else changes (alone, or in a batch). */
  const statedOnly = (batched: boolean) => {
    const update = { op: "updateObject", objectId: "m", changes: { atoms: [carbon, stated(1)], bonds: [carbonHydrogen] } };
    return { source: withMolecule, proposal: queued(batched ? { op: "batch", patches: [update] } : update) };
  };
  /** Updates m so its H states 1 AND is rebonded from the C to a new O: applying it clears the count. */
  const statedAndRebonded = () => ({
    source: withMolecule,
    proposal: queued({ op: "updateObject", objectId: "m", changes: {
      atoms: [carbon, stated(1), { id: "o", element: "O", x: 10, y: 10 }],
      bonds: [{ id: "co", fromAtomId: "c", toAtomId: "o", order: "single" }, { id: "oh", fromAtomId: "o", toAtomId: "h", order: "single" }]
    } })
  });

  // Mirrors PluginHost.previewProposedPatch for the one proposal it holds.
  const hostFor = (proposal: QueuedProposedPatch) => ({
    getPlugin: () => ({ manifest: { name: "Test Plugin" } }),
    previewProposedPatch: (_id: string, source: ChemDraftDocument, options: AcceptProposedPatchOptions = {}) =>
      options.apply!(source, proposal.proposal, {})
  }) as unknown as PluginHost;

  /** Accepts as MainWindow does: the same application, then the message read from what it committed. */
  function accept({ source, proposal }: { source: ChemDraftDocument; proposal: QueuedProposedPatch }) {
    const committed = previewAcceptedPluginProposal(hostFor(proposal), proposal.id, source);
    const message = acceptedProposalMessage("Test Plugin", proposal,
      { recognized: false, screenCapture: false, before: source, committed });
    const committedHydrogen = committed.pages.flatMap(page => page.objects)
      .flatMap(object => object.type === "molecule" ? object.atoms : []).find(atom => atom.id === "h");
    return { message, committedCount: committedHydrogen?.hydrogenCount };
  }

  const warningText = "atom h (H) states 1 hydrogen, which a hydrogen atom cannot carry: only 0 counts, as a typed H, D or T " +
    "label means. The stated count is kept as stored but not counted, and the atom is flagged.";

  it("warns in the review item when the count would be kept, naming the atom, its element and the count", async () => {
    for (const { source, proposal } of [added(1), statedOnly(false), statedOnly(true)]) {
      const item = await proposalReviewItem(hostFor(proposal), proposal, undefined, source);
      expect(item.warnings).toEqual([{ code: "document.atom_hydrogen_count_not_counted", message: `Proposed change: ${warningText}` }]);
      render([item]);
      expect(document.querySelector('[data-proposal-id="proposal-h"] .patch-review-warnings')?.textContent)
        .toBe(`Proposed change: ${warningText}`);
      unmount();
    }
  });

  it("says so in the accept message, which matches the committed document, and accepting stays a success", () => {
    for (const proposal of [added(1), statedOnly(false), statedOnly(true)]) {
      expect(accept(proposal)).toEqual({ message: `Test Plugin: applied proposal. Accepted change: ${warningText}`, committedCount: 1 });
    }
  });

  it("does not claim a count is kept when applying the update clears it (its bonds changed)", async () => {
    const proposal = statedAndRebonded();
    const item = await proposalReviewItem(hostFor(proposal.proposal), proposal.proposal, undefined, proposal.source);
    expect(item.warnings).toEqual([]);
    render([item]);
    expect(document.querySelector('[data-proposal-id="proposal-h"] .patch-review-warnings')).toBeNull();
    unmount();
    expect(accept(proposal)).toEqual({ message: "Test Plugin: applied proposal", committedCount: undefined });
  });

  it("shows no warning for a clean proposal, at review or accept", async () => {
    for (const count of [undefined, 0]) {
      const proposal = added(count);
      const item = await proposalReviewItem(hostFor(proposal.proposal), proposal.proposal, undefined, proposal.source);
      expect(item.warnings).toEqual([]);
      render([item]);
      expect(document.querySelector('[data-proposal-id="proposal-h"] .patch-review-warnings')).toBeNull();
      unmount();
      expect(accept(proposal)).toEqual({ message: "Test Plugin: applied proposal", committedCount: count });
    }
  });

  it("shows no hydrogen warning when the proposal would fail to apply, or there is no document to dry-run", async () => {
    const missing = queued({ op: "updateObject", objectId: "absent", changes: { atoms: [carbon, stated(1)], bonds: [carbonHydrogen] } });
    expect((await proposalReviewItem(hostFor(missing), missing, undefined, withMolecule)).warnings).toEqual([]);
    const proposal = added(1).proposal;
    expect((await proposalReviewItem(hostFor(proposal), proposal)).warnings).toEqual([]);
  });
});
