// Adapted from p2 (apps/p2/src/web/activity/ActivityRow.tsx; `useElapsed` from ActivitySheet.tsx).
// A block's compact activity wheel in the transcript. The wheel opens this block's steps in place, below it.
import { type MouseEvent, type ReactNode, useEffect, useState } from "react";
import { Ticker } from "../elanor-extra/ticker.tsx";
import { CheckIcon, ChevronIcon, SparkIcon } from "./icons.tsx";
import { KindIcon, LabelText } from "./Label.tsx";
import { elapsed, live, plain, type Step, summary, type WheelEntry } from "./model.ts";
import { StepList } from "./StepList.tsx";
import "./activity.css";

/** A step on the wheel: what it shows, its plain words for screen readers, and whether it failed. */
type Face = { key: string; label: string; content: ReactNode; failed?: boolean };

/** A live duration, or the total once the run is done; unknown without either endpoint. */
function useElapsed(startedAt: number | undefined, endedAt: number | undefined, working: boolean) {
  const [mounted] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [working]);
  const start = startedAt ?? (working ? mounted : undefined);
  const end = working ? now : endedAt;
  return start === undefined || end === undefined ? undefined : elapsed(end - start);
}

/** How long the run has taken: counting while the agent works, the total once it is done. */
function Elapsed({ startedAt, endedAt, working }: { startedAt?: number; endedAt?: number; working: boolean }) {
  const time = useElapsed(startedAt, endedAt, working);
  if (time === undefined) return null;
  return (
    <span className="activity-time" data-testid="activity-time">
      {time}
    </span>
  );
}

export function ActivityRow({
  steps,
  entries = steps.map((step) => ({ kind: "call", step })),
  working,
  startedAt,
  endedAt,
}: {
  /** The row's key in the transcript. */
  rowKey: string;
  steps: readonly Step[];
  /** Everything on the wheel in order: thinking among the calls. Default: the steps. */
  entries?: readonly WheelEntry[];
  working: boolean;
  startedAt?: number;
  endedAt?: number;
}) {
  const [selected, setSelected] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const thought = entries.some((entry) => entry.kind === "thought");
  // "Thought, set a reminder": with thinking on the wheel, its summary says so first.
  const calls = steps.length ? summary(steps) : "";
  const done = thought
    ? ["Thought", calls.charAt(0).toLowerCase() + calls.slice(1)].filter(Boolean).join(", ")
    : calls || summary(steps);
  const toggle = (id: string) =>
    setExpanded((before) => {
      const next = new Set(before);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  /** Opens this block's steps, expanding the step selected on the wheel; a tap on an open block closes them. */
  const show = (step?: string) => {
    const known = entries.some((each) => (each.kind === "call" ? each.step.id : each.id) === step);
    if (!selected && step && known && !expanded.has(step)) toggle(step);
    setSelected(!selected);
  };
  /** A tap beside the wheel; the wheel's own tap (its button) is `onActivate`. */
  const tap = (event: MouseEvent) => {
    if (!(event.target instanceof Element && event.target.closest(".activity-ticker"))) show();
  };
  const faces: Face[] = entries.map((entry) => {
    if (entry.kind !== "call") {
      const words = entry.live ? "Thinking…" : "Thought";
      return {
        key: entry.id,
        label: words,
        content: (
          <>
            <SparkIcon />
            <span className="label-text">{words}</span>
          </>
        ),
      };
    }
    const { step } = entry;
    const label = live(step);
    return {
      key: step.id,
      label: plain(label),
      failed: step.status === "error",
      content: (
        <>
          <KindIcon kind={label.kind} />
          <LabelText label={label} />
        </>
      ),
    };
  });
  // Waiting for the first step: nothing to open yet, so the wheel is no button.
  if (!entries.length)
    return (
      <div className="activity-block">
        <div className="activity" data-testid="activity" data-state="working">
          <Ticker.Root className="activity-ticker" active>
            <Ticker.Item key="waiting" label="Working">
              <SparkIcon />
              <span className="label-text">Working…</span>
            </Ticker.Item>
          </Ticker.Root>
          <Elapsed startedAt={startedAt} endedAt={endedAt} working={working} />
        </div>
      </div>
    );
  if (!working)
    faces.push({
      key: "done",
      label: done,
      content: (
        <>
          <CheckIcon />
          <span className="label-text">
            {done}
            <span className="label-extra">
              {" "}
              · {entries.length} {entries.length === 1 ? "step" : "steps"}
            </span>
          </span>
        </>
      ),
    });
  return (
    <div className={`activity-block${selected ? " selected" : ""}`}>
      {/* The row: the wheel is the button (a tap opens the steps, a drag rolls it); the rest of the row opens them
          too, for a pointer. */}
      <div
        className="activity activity-turn"
        data-testid="activity"
        data-state={working ? "working" : "done"}
        onClick={tap}
      >
        <Ticker.Root
          className="activity-ticker"
          active={working}
          // The face in front opens: a step expanded (the newest too: the Ticker leaves its key out), the summary the
          // block.
          onActivate={(key) => show(key ?? faces.at(-1)?.key)}
          aria-label={`${faces.at(-1)?.label ?? "Working"}. Show the steps`}
          aria-expanded={selected}
        >
          {faces.map((face) => (
            <Ticker.Item key={face.key} label={face.label} negative={face.failed}>
              {face.content}
            </Ticker.Item>
          ))}
        </Ticker.Root>
        <Elapsed startedAt={startedAt} endedAt={endedAt} working={working} />
        <span className="activity-chevron" aria-hidden="true">
          <ChevronIcon />
        </span>
      </div>
      {selected && <StepList entries={entries} expanded={expanded} onStep={toggle} />}
    </div>
  );
}
