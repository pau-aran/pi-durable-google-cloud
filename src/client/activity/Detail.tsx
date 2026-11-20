// Adapted from p2 (apps/p2/src/web/activity/Detail.tsx).
// A step's detail: a call's input as JSON, then its output; a thought's text as prose.
import type { ReactNode } from "react";
import { CodeBlock } from "../Code.tsx";
import { Markdown } from "../Markdown.tsx";
import type { Step } from "./model.ts";

/** A quiet line: what a section lacks, how a call ended. */
const DetailNote = ({ children }: { children: ReactNode }) => <p className="detail-note">{children}</p>;

/** A labelled part of a detail ("Input", "Output"). */
const DetailSection = ({ label, children }: { label: string; children: ReactNode }) => (
  <section className="detail-section" data-testid={`detail-${label.toLowerCase()}`}>
    <h4 className="detail-label">{label}</h4>
    {children}
  </section>
);

/**
 * Output in a terminal block, whole: a long one scrolls with the page (a detail has no collapsed parts). A failure is
 * red, no louder than that.
 */
function OutputBlock({ output, failed }: { output: string; failed?: boolean }) {
  const text = output.trimEnd();
  if (!text) return <DetailNote>No output</DetailNote>;
  return (
    <div className="detail-terminal" data-failed={failed || undefined}>
      <pre className="detail-output">{text}</pre>
    </div>
  );
}

/** Markdown in a detail: a thought. */
export const DetailProse = ({ text }: { text: string }) => (
  <div className="detail-prose" data-text-context="prose">
    <Markdown text={text} />
  </div>
);

/** A call's detail: the input as JSON, then the output. */
export function GenericDetail({ step }: { step: Step }) {
  const { tool } = step;
  return (
    <>
      <DetailSection label="Input">
        <CodeBlock code={JSON.stringify(tool.args, null, 2)} language="json" />
      </DetailSection>
      <DetailSection label="Output">
        <OutputBlock output={tool.output} failed={step.status === "error"} />
      </DetailSection>
      <Interrupted step={step} />
    </>
  );
}

/** Says when a restart cut a call short: it was not run again. */
const Interrupted = ({ step }: { step: Step }) =>
  step.tool.status === "interrupted" ? <DetailNote>Interrupted by a restart, not run again.</DetailNote> : null;
