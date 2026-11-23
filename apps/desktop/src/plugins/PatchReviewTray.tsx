import { useEffect, useMemo, useState } from "react";
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
  useEffect(() => {
    let cancelled = false;
    void Promise.all(pending.map(proposal =>
      proposalReviewItem(host, proposal, getDocumentName?.(proposal), getSourceDocument?.(proposal))))
      .then(items => { if (!cancelled) setItems(items); });
    return () => { cancelled = true; };
  }, [pending, host, getDocumentName, getSourceDocument]);

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
  host: Pick<PluginHost, "getPlugin" | "previewProposedPatch">, proposal: QueuedProposedPatch, documentName?: string,
  sourceDocument?: ChemDraftDocument
): Promise<PluginProposalReviewItem> {
  // The plugin host already attached its own record of a recognition (tier, image, warnings) on queueing.
  const { recognition, warnings } = reviewedRecognition(proposal.proposal.recognition, proposal.proposal.warnings);
  return {
    id: proposal.id,
    pluginId: proposal.pluginId,
    pluginName: host.getPlugin(proposal.pluginId)?.manifest.name ?? proposal.pluginId,
    reason: proposal.proposal.reason,
    documentName,
    // An H, D or T atom stating a count it cannot carry is accepted as written (proposals are exempt
    // from the plugin-boundary refusal) and flagged once committed; the review says so beforehand.
    warnings: [...warnings, ...proposalHydrogenCountWarnings(host, proposal, sourceDocument)],
    recognition,
    structurePreview: await recognitionStructurePreview(proposal.proposal)
  };
}

/**
 * The hydrogen-count warning for a pending proposal, read from the document accepting it into
 * `sourceDocument` would produce: the accept's own application, dry-run (nothing is committed). A
 * proposal that would fail to apply gets none; the accept reports that failure.
 */
function proposalHydrogenCountWarnings(
  host: Pick<PluginHost, "previewProposedPatch">, proposal: QueuedProposedPatch, sourceDocument: ChemDraftDocument | undefined
): { code: string; message: string }[] {
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
