import { useEffect, useMemo, useRef, useState } from "react";
import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { proposedHydrogenCountNotCountedWarnings } from "@chemdraft/document-workflow-core";
import type { PluginHost, QueuedProposedPatch } from "@chemdraft/plugin-host";
import { previewAcceptedPluginProposal } from "./applyPluginDocumentPatch";
import type { PluginProposalReviewItem } from "./panelBridge";
import { EXPERIMENTAL_RECOGNITION_REVIEW_NOTICE } from "./pluginUpdates";
import { reviewedRecognition } from "./recognitionAgreement";
import { recognitionStructurePreview } from "./recognitionPreview";

/**
 * Review affordance for the proposePatch flow. Plugins queue document changes; the user accepts or
 * rejects them here. This tray remains the only path from a proposal into document history;
 * command-scoped `document.write` patches deliberately bypass the proposal queue.
 */
export function PatchReviewTray({
  host,
  queueVersion,
  getDocumentName,
  getSourceDocument,
  onAccept,
  onReject
}: {
  host: PluginHost;
  /** Bumped by the host's onProposedPatchesChanged callback so the pending list recomputes. */
  queueVersion: number;
  getDocumentName?(proposal: QueuedProposedPatch): string | undefined;
  /** The document the proposal would be accepted into, for its dry run (see `proposalReviewItem`). */
  getSourceDocument?(proposal: QueuedProposedPatch): ChemDraftDocument | undefined;
  onAccept(proposal: QueuedProposedPatch): void;
  onReject(proposal: QueuedProposedPatch): void;
}) {
  const [open, setOpen] = useState(false);
  const pending = useMemo(
    () => host.listProposedPatches("pending"),
    // queueVersion is the change signal; the host itself is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [host, queueVersion]
  );

  const [items, setItems] = useState<PluginProposalReviewItem[]>([]);
  // Review items are memoized per proposal on its source document's identity. The check runs after
  // every render (the owner re-renders when a document changes), but only a proposal whose document,
  // name, or queue entry changed is rebuilt; an unrelated render rebuilds nothing.
  const cache = useMemo(() => new ProposalReviewItemCache(), []);
  const request = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    const inputs = (proposal: QueuedProposedPatch) =>
      ({ documentName: getDocumentName?.(proposal), sourceDocument: getSourceDocument?.(proposal) });
    if (!cache.isStale(host, pending, inputs)) return;
    // Only the latest build lands: an earlier one still rendering a preview must not overwrite it.
    const current = ++request.current;
    void cache.items(host, pending, inputs).then(items => { if (mounted.current && current === request.current) setItems(items); });
  });

  if (pending.length === 0) {
    return null;
  }

  return (
    <div className="patch-review-tray" data-patch-review-tray="true">
      {open ? (
        <div className="patch-review-popover" role="dialog" aria-label="Plugin proposals awaiting review">
          <PatchReviewList
            proposals={items}
            onAccept={(proposalId) => {
              const proposal = pending.find((candidate) => candidate.id === proposalId);
              if (proposal) onAccept(proposal);
            }}
            onReject={(proposalId) => {
              const proposal = pending.find((candidate) => candidate.id === proposalId);
              if (proposal) onReject(proposal);
            }}
          />
        </div>
      ) : null}
      <button
        type="button"
        className="patch-review-badge"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {pendingProposalsLabel(pending.length)}
      </button>
    </div>
  );
}

export function pendingProposalsLabel(count: number): string {
  return count === 1 ? "1 plugin proposal" : `${count} plugin proposals`;
}

/**
 * Desktop way back to the Plugin Proposals window. Proposals review in their own native window,
 * which the user can close with proposals still pending; without this badge they would be
 * unreachable until the queue changed. Shown only while proposals wait and the window is closed.
 */
export function PendingProposalsBadge({
  count,
  windowOpen,
  onReview
}: {
  count: number;
  windowOpen: boolean;
  onReview(): void;
}) {
  if (count <= 0 || windowOpen) return null;
  return (
    <div className="patch-review-tray" data-pending-proposals-badge="true">
      <button
        type="button"
        className="patch-review-badge"
        title="Review plugin proposals"
        onClick={onReview}
      >
        {pendingProposalsLabel(count)}
      </button>
    </div>
  );
}

/** Shared proposal body used by the browser tray and the desktop analysis window. */
export function PatchReviewList({
  proposals,
  notices,
  busyIds,
  onAccept,
  onReject
}: {
  proposals: readonly PluginProposalReviewItem[];
  /** Why the last Accept/Reject on a proposal did not go through, keyed by proposal id. */
  notices?: Readonly<Record<string, string>>;
  /** Proposals whose Accept/Reject is still waiting for an answer. */
  busyIds?: ReadonlySet<string>;
  onAccept(proposalId: string): void;
  onReject(proposalId: string): void;
}) {
  return (
    <div className="patch-review-list" data-testid="patch-review-list">
      {proposals.map((proposal) => (
        <div className="patch-review-item" key={proposal.id} data-proposal-id={proposal.id}>
          <div className="patch-review-item-header">
            <span className="patch-review-plugin">{proposal.pluginName}</span>
          </div>
          <p className="patch-review-reason">{proposal.reason}</p>
          {proposal.documentName ? <p className="patch-review-document">Document: {proposal.documentName}</p> : null}
          {proposal.recognition ? (
            <div className="patch-review-recognition" data-testid="recognition-proposal-preview">
              <img src={proposal.recognition.sourceImageRef} alt="Source submitted for structure recognition" />
              <div>
                <span className={`patch-review-confidence is-${proposal.recognition.confidenceTier}`}>
                  {capitalize(proposal.recognition.confidenceTier)} confidence
                </span>
                {proposal.structurePreview ? (
                  <img
                    className="patch-review-structure"
                    src={proposal.structurePreview}
                    alt="Recognized structure"
                    data-testid="recognition-structure-preview"
                  />
                ) : null}
                {proposal.recognition.proposedSmiles ? (
                  <p>
                    Recognized structure: <code>{proposal.recognition.proposedSmiles}</code>
                  </p>
                ) : (
                  <p>Recognized structure: MOL structure ready for review</p>
                )}
                <p className="patch-review-experimental-note" data-testid="recognition-experimental-note">
                  {EXPERIMENTAL_RECOGNITION_REVIEW_NOTICE}
                </p>
              </div>
            </div>
          ) : null}
          {proposal.warnings.length > 0 ? (
            <ul className="patch-review-warnings">
              {proposal.warnings.map((warning, index) => (
                <li key={`${warning.code}-${index}`}>{warning.message}</li>
              ))}
            </ul>
          ) : null}
          {notices?.[proposal.id] ? (
            <p className="patch-review-error" role="alert">
              {notices[proposal.id]}
            </p>
          ) : null}
          <div className="patch-review-actions">
            <button type="button" disabled={busyIds?.has(proposal.id)} onClick={() => onAccept(proposal.id)}>
              Accept
            </button>
            <button type="button" disabled={busyIds?.has(proposal.id)} onClick={() => onReject(proposal.id)}>
              Reject
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * What the review shows for a pending proposal. `sourceDocument` is the document it would be
 * accepted into; the hydrogen-count warning is read from a dry run of the accept on it (see
 * `proposalHydrogenCountWarnings`), and without one there is nothing to dry-run, so no such warning.
 */
export async function proposalReviewItem(
  host: ProposalReviewHost, proposal: QueuedProposedPatch, documentName?: string,
  sourceDocument?: ChemDraftDocument
): Promise<PluginProposalReviewItem> {
  return reviewItem(await proposalReviewBase(host, proposal), documentName,
    proposalHydrogenCountWarnings(host, proposal, sourceDocument));
}

type ProposalReviewHost = Pick<PluginHost, "getPlugin" | "previewProposedPatch">;
type ReviewWarning = { code: string; message: string };
/** The parts of a review item that depend on the proposal alone, not on the document it targets. */
type ProposalReviewBase = Omit<PluginProposalReviewItem, "documentName">;

async function proposalReviewBase(host: ProposalReviewHost, proposal: QueuedProposedPatch): Promise<ProposalReviewBase> {
  // The plugin host already attached its own record of a recognition (tier, image, warnings) on queueing.
  const { recognition, warnings } = reviewedRecognition(proposal.proposal.recognition, proposal.proposal.warnings);
  return {
    id: proposal.id,
    pluginId: proposal.pluginId,
    pluginName: host.getPlugin(proposal.pluginId)?.manifest.name ?? proposal.pluginId,
    reason: proposal.proposal.reason,
    warnings,
    recognition,
    structurePreview: await recognitionStructurePreview(proposal.proposal)
  };
}

function reviewItem(base: ProposalReviewBase, documentName: string | undefined, hydrogen: readonly ReviewWarning[]): PluginProposalReviewItem {
  return {
    ...base,
    documentName,
    // An H, D or T atom stating a count it cannot carry is accepted as written (proposals are exempt
    // from the plugin-boundary refusal) and flagged once committed; the review says so beforehand.
    warnings: [...base.warnings, ...hydrogen]
  };
}

/** What a pending proposal's review item is built against: its tab's name and document. */
export type ProposalReviewInputs = { documentName?: string; sourceDocument?: ChemDraftDocument };

type CachedReviewItem = {
  base: Promise<ProposalReviewBase>;
  documentName: string | undefined;
  sourceDocument: ChemDraftDocument | undefined;
  hydrogen: readonly ReviewWarning[];
};

/**
 * Review items for the pending proposals, memoized so that the review follows edits to the document
 * a proposal would be accepted into without redoing work on renders that changed nothing. A
 * proposal's recognition preview is built once; its hydrogen-count dry run is redone only when its
 * source document is a different object (documents are immutable, so identity is the version) and
 * otherwise reused. The browser tray and the desktop Plugin Proposals window each hold one.
 */
export class ProposalReviewItemCache {
  private host: ProposalReviewHost | undefined;
  private entries = new Map<string, CachedReviewItem>();
  private lastPending: readonly QueuedProposedPatch[] = [];

  /** Forgets every item, for when the queue empties. */
  clear(): void {
    this.entries.clear();
    this.lastPending = [];
  }

  /** The pending proposals the last `items` call built items for. */
  get pending(): readonly QueuedProposedPatch[] {
    return this.lastPending;
  }

  /**
   * Whether `items` would rebuild anything: a different host, a proposal added or gone, or a
   * proposal whose document name or source document (by identity) differs from its last build.
   * Cheap: no dry run, no copy of the queue.
   */
  isStale(host: ProposalReviewHost, pending: readonly QueuedProposedPatch[], inputs: (proposal: QueuedProposedPatch) => ProposalReviewInputs): boolean {
    if (host !== this.host || pending.length !== this.entries.size) return true;
    return pending.some((proposal) => {
      const entry = this.entries.get(proposal.id);
      if (!entry) return true;
      const { documentName, sourceDocument } = inputs(proposal);
      return entry.documentName !== documentName || entry.sourceDocument !== sourceDocument;
    });
  }

  /**
   * The review items for `pending`, in order. Records what each was built against before returning,
   * so `isStale` with the same inputs is false straight away even while previews are still rendering.
   */
  items(host: ProposalReviewHost, pending: readonly QueuedProposedPatch[], inputs: (proposal: QueuedProposedPatch) => ProposalReviewInputs): Promise<PluginProposalReviewItem[]> {
    if (host !== this.host) {
      this.host = host;
      this.entries.clear();
    }
    const entries = new Map<string, CachedReviewItem>();
    const items = pending.map((proposal) => {
      const { documentName, sourceDocument } = inputs(proposal);
      const prior = this.entries.get(proposal.id);
      const entry: CachedReviewItem = {
        base: prior?.base ?? proposalReviewBase(host, proposal),
        documentName,
        sourceDocument,
        hydrogen: prior && prior.sourceDocument === sourceDocument
          ? prior.hydrogen : proposalHydrogenCountWarnings(host, proposal, sourceDocument)
      };
      entries.set(proposal.id, entry);
      return entry.base.then((base) => reviewItem(base, documentName, entry.hydrogen));
    });
    this.entries = entries;
    this.lastPending = pending;
    return Promise.all(items);
  }
}

/**
 * The hydrogen-count warning for a pending proposal, read from the document accepting it into
 * `sourceDocument` would produce: the accept's own application, dry-run (nothing is committed). A
 * proposal that would fail to apply gets none; the accept reports that failure.
 */
function proposalHydrogenCountWarnings(
  host: Pick<PluginHost, "previewProposedPatch">, proposal: QueuedProposedPatch, sourceDocument: ChemDraftDocument | undefined
): ReviewWarning[] {
  if (!sourceDocument) return [];
  let produced: ChemDraftDocument;
  try {
    produced = previewAcceptedPluginProposal(host, proposal.id, sourceDocument);
  } catch {
    return [];
  }
  return proposedHydrogenCountNotCountedWarnings(sourceDocument, produced, proposal.proposal.patch)
    .map(({ code, message }) => ({ code, message }));
}

/**
 * The status line after the user accepts a proposal. A proposal is accepted as written even when an
 * H, D or T atom states a hydrogen count it cannot carry, so the message names each such atom that
 * `committed` (the document the accept produced from `before`) still holds, rather than reporting a
 * plain success.
 */
export function acceptedProposalMessage(
  pluginName: string, proposal: QueuedProposedPatch,
  options: { recognized: boolean; screenCapture: boolean; before: ChemDraftDocument; committed: ChemDraftDocument }
): string {
  const inserted = options.recognized ? `${pluginName}: inserted recognized structure` : `${pluginName}: applied proposal`;
  const message = options.screenCapture
    ? `${inserted}; its screen capture stays saved (Add or Remove Plugins › Show saved screen captures)`
    : inserted;
  const notCounted = proposedHydrogenCountNotCountedWarnings(options.before, options.committed, proposal.proposal.patch, "Accepted change");
  return notCounted.length ? `${message}. ${notCounted.map((warning) => warning.message).join(" ")}` : message;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`;
}
