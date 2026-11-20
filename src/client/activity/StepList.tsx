// Adapted from p2 (apps/p2/src/web/activity/ActivitySheet.tsx, `StepList`).
import type { ReactNode } from "react";
import { clockTime, Time } from "../Time.tsx";
import { DetailProse, GenericDetail } from "./Detail.tsx";
import { ChevronIcon, SparkIcon } from "./icons.tsx";
import { KindIcon } from "./Label.tsx";
import { argumentOf, describe, plainText, sentence, stepState, type WheelEntry } from "./model.ts";
import "./activity.css";

/**
 * A block's steps, each with, under its state, when it started: only where the clock shows another minute than the
 * step before it, so a run within a minute names its time once. Their details expand beneath their headers.
 */
export function StepList({
  entries,
  onStep,
  expanded,
}: {
  entries: readonly WheelEntry[];
  onStep: (id: string) => void;
  expanded: ReadonlySet<string>;
}) {
  let shownTime: string | undefined;
  return (
    <ul className="step-list" data-testid="timeline">
      {entries.map((entry) => {
        const step = entry.kind === "call" ? entry.step : undefined;
        const at = step?.tool.at;
        const label = at === undefined ? undefined : clockTime(at);
        const time = label === shownTime ? undefined : at;
        if (label) shownTime = label;
        const id = entry.kind === "call" ? entry.step.id : entry.id;
        const open = expanded.has(id);
        const thought = entry.kind === "call" ? undefined : entry;
        const argument = step ? argumentOf(step.tool) : plainText(sentence(thought?.text ?? ""));
        const icon: ReactNode = step ? <KindIcon kind={describe(step).kind} /> : <SparkIcon />;
        return (
          <li
            key={id}
            data-testid="step"
            data-step-id={id}
            data-state={step?.status ?? "done"}
            data-kind={thought?.kind}
          >
            <button type="button" className="step-row" onClick={() => onStep(id)} aria-expanded={open}>
              <span className="step-icon">{icon}</span>
              <span className="step-words">
                <span className="step-name">{step ? step.tool.name : "Thought"}</span>
                {argument && <span className="step-argument">{argument}</span>}
              </span>
              <span className="step-end">
                <span className="step-state" data-state={step?.status ?? "done"}>
                  {step ? stepState(step) : thought?.live ? "● thinking" : ""}
                </span>
                {time !== undefined && <Time at={time} className="step-time" />}
              </span>
              <span className="step-chevron" aria-hidden="true">
                <ChevronIcon size={16} />
              </span>
            </button>
            {open && (
              <div className="activity-detail">
                {step ? <GenericDetail step={step} /> : <DetailProse text={thought?.text ?? ""} />}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
