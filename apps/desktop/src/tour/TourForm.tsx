import { useEffect, useRef, useState } from "react";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import type { KeybindingScheme } from "../keybindingSettings";
import { detectDesktopShortcutPlatform } from "../keyboardShortcuts";
import { TOUR_TITLE, type TourAction, type TourPluginCommand } from "./tourCommands";
import { tourShortcutChoices, tourSteps } from "./tourSteps";
import "./TourForm.css";

export function TourForm({
  scheme, onAction, onReady, busy, error, platform = detectDesktopShortcutPlatform(), plugins = []
}: {
  scheme: KeybindingScheme;
  onAction: (action: TourAction) => void;
  onReady?: () => void;
  busy?: boolean;
  error?: string;
  platform?: ShortcutPlatform;
  /** Plugin commands the menus offered when the tour opened. Missing means none: never demo a plugin
   *  that might not be installed. */
  plugins?: readonly TourPluginCommand[];
}) {
  const [index, setIndex] = useState(0);
  // The step list is fixed when the tour opens. Installing or removing a plugin while it is open does
  // not add or drop steps under the user, so the step number, Back, Next and Finish stay put.
  const [openedWith] = useState(() => [...plugins]);
  // The host keeps its error until the next action, but an error belongs to the step whose action
  // raised it. Moving to another step, forward or back, clears it, including a late error from an
  // action still in flight; the next action on the new step shows errors again.
  const [errorStep, setErrorStep] = useState<number | undefined>(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const steps = tourSteps(scheme, platform, openedWith);
  const step = steps[index];
  const tryCommand = step.tryCommand;
  const url = step.url;
  const visibleError = errorStep === index ? error : undefined;
  const goTo = (next: number) => { setErrorStep(undefined); setIndex(next); };
  const send = (action: TourAction) => { setErrorStep(index); onAction(action); };

  useEffect(() => { onReady?.(); }, [onReady]);
  useEffect(() => { heading.current?.focus(); }, [index]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      setErrorStep(index);
      onAction({ action: "cancel" });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onAction, index]);

  return (
    <section className="guided-tour" role="dialog" aria-label={TOUR_TITLE}>
      <div className="guided-tour-content">
        <p className="guided-tour-counter">Step {index + 1} of {steps.length}</p>
        <h1 ref={heading} tabIndex={-1}>{step.title}</h1>
        <p>{step.text}</p>
        {url ? <p className="guided-tour-url">
          {/* The link never navigates this window: the host opens the address in the system browser.
              Enter on the focused link fires this click, as it does for any link. */}
          <a href={url} onClick={event => { event.preventDefault(); send({ action: "openGuide", url }); }}>{url}</a>
        </p> : null}
        {step.shortcuts ? (
          <fieldset disabled={busy}>
            <legend>Keyboard shortcuts</legend>
            {tourShortcutChoices(platform).map(choice => (
              <label key={choice.scheme}>
                <input type="radio" name="tour-shortcuts" checked={scheme === choice.scheme}
                  onChange={() => send({ action: "chooseShortcuts", scheme: choice.scheme })} />
                <span>{choice.label}
                  <small>{choice.examples.map(({ label, key }) => <span key={label}>{label} <kbd>{key}</kbd></span>)}</small>
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}
        {tryCommand ? <button type="button" disabled={busy}
          onClick={() => send({ action: "tryTourCommand", command: tryCommand })}>Try it</button> : null}
        {visibleError ? <p role="alert">{visibleError}</p> : null}
      </div>
      <footer>
        <button type="button" onClick={() => send({ action: "cancel" })}>Skip tour</button>
        <button type="button" disabled={index === 0} onClick={() => goTo(index - 1)}>Back</button>
        {index < steps.length - 1
          ? <button type="button" className="guided-tour-primary" onClick={() => goTo(index + 1)}>Next</button>
          : <button type="button" className="guided-tour-primary" disabled={busy}
              onClick={() => send({ action: "finish" })}>Finish</button>}
      </footer>
    </section>
  );
}
