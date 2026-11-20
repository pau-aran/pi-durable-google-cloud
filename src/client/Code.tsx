// STUB of p2's apps/p2/src/web/Code.tsx. CONTRACT: `CodeBlock({ code, language })` and `CopyButton({ text })`.
export function CopyButton({ text }: { text: string }) {
  return (
    <button type="button" className="copy" aria-label="Copy" onClick={() => void navigator.clipboard.writeText(text)}>
      Copy
    </button>
  );
}

export function CodeBlock({ code }: { code: string; language?: string }) {
  return <pre>{code}</pre>;
}
