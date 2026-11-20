// STUB of p2's apps/p2/src/web/activity/ActivityRow.tsx. CONTRACT: the props.
import type { Step, WheelEntry } from "./model.ts";

export function ActivityRow(props: {
  /** The row's key in the transcript. */
  rowKey: string;
  steps: readonly Step[];
  /** Everything on the wheel in order: thinking among the calls. Default: the steps. */
  entries?: readonly WheelEntry[];
  working: boolean;
  startedAt?: number;
  endedAt?: number;
}) {
  return <div className="activity">{props.working ? "Working…" : `${props.steps.length} steps`}</div>;
}
