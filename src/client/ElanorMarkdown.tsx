// Adapted from p2 (apps/p2/src/web/ElanorMarkdown.tsx).
// Markdown in Elanor's components (the approach of pi.dev's docs, design-refresh): Markdown.tsx's elements mapped to
// Elanor's Prose, Text, Heading, List, Link, Strong, Emphasis, InlineCode, Blockquote, Separator, Table and
// CodeSnippet. p2's parser, its safety (raw HTML as text, remote images as links) and its streaming stay as they are.
import {
  Blockquote,
  Checkbox,
  CodeSnippet,
  CopyButton,
  Emphasis,
  Heading,
  InlineCode,
  Link,
  List,
  Prose,
  Separator,
  Strong,
  Table,
  Text,
} from "@earendil-works/elanor-react";
import { type ComponentProps, useMemo } from "react";
import { highlightCode } from "./Code.tsx";
import "./elanor-markdown.css";

/** A fenced code block: highlighted, with Copy. */
function ElanorCodeBlock({ code, language }: { code: string; language?: string }) {
  const content = useMemo(() => highlightCode(code, language), [code, language]);
  return (
    <CodeSnippet actions={<CopyButton value={code} aria-label="Copy code" />} data-language={language}>
      {content}
    </CodeSnippet>
  );
}

// Headings in an answer are small: an answer is not a page. Markdown's # and ## are size 5;
// deeper ones are size 6, the text's own size.
function MarkdownHeading({ depth, children }: { depth: number; children: React.ReactNode }) {
  const level = depth === 1 ? 3 : depth === 2 ? 4 : depth === 3 ? 5 : 6;
  return <Heading level={level} variant="marketing" size={level <= 4 ? 5 : 6}>{children}</Heading>;
}

/** A task item's checkbox shows its state; it is not a control here. */
function MarkdownCheckbox({ checked }: { checked: boolean }) {
  return (
    <Checkbox.Root className="markdown-checkbox" checked={checked} readOnly aria-label={checked ? "Done" : "Not done"}>
      <Checkbox.Indicator />
    </Checkbox.Root>
  );
}

/** The component map for chat Markdown, without per-message overrides. */
export const ElanorMarkdown = {
  Root: (props: ComponentProps<"div">) => <Prose className="elanor-markdown" {...props} />,
  Paragraph: Text,
  Heading: MarkdownHeading,
  Strong,
  Emphasis,
  InlineCode,
  Link,
  List: List.Root,
  ListItem: List.Item,
  Blockquote,
  Separator,
  Table,
  CodeBlock: ElanorCodeBlock,
  Checkbox: MarkdownCheckbox,
};
