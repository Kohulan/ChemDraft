// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PluginHost, QueuedProposedPatch } from "@chemdraft/plugin-host";
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
  const host = { getPlugin: () => ({ manifest: { name: "Test Plugin" } }) } as unknown as PluginHost;

  function queued(hydrogenCount: number | undefined, op: "addObject" | "updateObject" = "addObject"): QueuedProposedPatch {
    const atoms = [
      { id: "c", element: "C", x: 0, y: 0 },
      { id: "h", element: "H", x: 20, y: 0, ...(hydrogenCount === undefined ? {} : { hydrogenCount }) }
    ];
    const bonds = [{ id: "b", fromAtomId: "c", toAtomId: "h", order: 1 }];
    const patch = op === "addObject"
      ? { op, pageId: "page-1", object: { id: "m", type: "molecule", x: 0, y: 0, width: 20, height: 1, atoms, bonds } }
      : { op: "batch", patches: [{ op, objectId: "m", changes: { atoms, bonds } }] };
    return {
      id: "proposal-h", pluginId: "org.example.test", status: "pending", createdAt: "2026-11-22T00:00:00.000Z",
      proposal: { patch, reason: "Adds a molecule.", warnings: [], requiresUserApproval: true }
    } as QueuedProposedPatch;
  }

  const warningText = "atom h (H) states 1 hydrogen, which a hydrogen atom cannot carry: only 0 counts, as a typed H, D or T " +
    "label means. The stated count is kept as stored but not counted, and the atom is flagged.";

  it("warns in the review item, naming the atom, its element and the count", async () => {
    for (const op of ["addObject", "updateObject"] as const) {
      const item = await proposalReviewItem(host, queued(1, op));
      expect(item.warnings).toEqual([{ code: "document.atom_hydrogen_count_not_counted", message: `Proposed change: ${warningText}` }]);
      render([item]);
      expect(document.querySelector('[data-proposal-id="proposal-h"] .patch-review-warnings')?.textContent)
        .toBe(`Proposed change: ${warningText}`);
      unmount();
    }
  });

  it("says so in the accept message, and accepting stays a success", () => {
    expect(acceptedProposalMessage("Test Plugin", queued(1), { recognized: false, screenCapture: false }))
      .toBe(`Test Plugin: applied proposal. Accepted change: ${warningText}`);
  });

  it("shows no warning for a clean proposal, at review or accept", async () => {
    for (const count of [undefined, 0]) {
      const item = await proposalReviewItem(host, queued(count));
      expect(item.warnings).toEqual([]);
      render([item]);
      expect(document.querySelector('[data-proposal-id="proposal-h"] .patch-review-warnings')).toBeNull();
      unmount();
      expect(acceptedProposalMessage("Test Plugin", queued(count), { recognized: false, screenCapture: false }))
        .toBe("Test Plugin: applied proposal");
    }
  });
});
