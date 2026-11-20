// STUB of p2's apps/p2/src/web/Chat.tsx. CONTRACT: the props of `Messages`.
import type { TranscriptItem } from "@earendil-works/pi-durable";
import { ActivityRow } from "./activity/ActivityRow.tsx";
import { chatItems } from "./activity/model.ts";
import type { Transcript } from "./transcript.ts";

/** The transcript: its rows, the edge of the loaded history above them, and the run's notices below. */
export function Messages(props: {
  transcript: Transcript;
  /**
   * The loaded history's top edge: older history exists ("more"), is being fetched ("loading"), or the transcript
   * starts here ("start").
   */
  earlier: "more" | "loading" | "start";
  onEarlier: () => void;
  /** Load the next page of a gap's entries. */
  onFillGap: (gap: Extract<TranscriptItem, { kind: "gap" }>) => void;
}) {
  return (
    <div className="messages">
      {chatItems(props.transcript.items, props.transcript.working).map((item) => (
        <div key={item.key} className="row">
          {item.type === "activity" ? <ActivityRow rowKey={item.key} steps={item.steps} working={item.working} /> : "text" in item ? item.text : item.type}
        </div>
      ))}
    </div>
  );
}
