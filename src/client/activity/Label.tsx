// Adapted from p2 (apps/p2/src/web/activity/Label.tsx).
// A step's words with its kind's icon: a verb, then what it acted on (a command in the code font, the agent's own words
// as they are).
import type { ReactNode } from "react";
import { AlarmIcon, ToolIcon } from "./icons.tsx";
import type { Kind, Label } from "./model.ts";

const ICONS: Record<Kind, () => ReactNode> = {
  reminder: () => <AlarmIcon />,
  tool: () => <ToolIcon />,
};

export const KindIcon = ({ kind }: { kind: Kind }) => ICONS[kind]();

export function LabelText({ label }: { label: Label }) {
  return (
    <span className="label-text" data-kind={label.kind}>
      {label.verb && <span className="label-verb">{label.verb}</span>}
      {label.verb && label.object ? " " : null}
      {label.object && (
        <span className="label-object" data-style={label.style}>
          {label.object}
        </span>
      )}
    </span>
  );
}
