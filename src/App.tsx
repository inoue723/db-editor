import { useState } from "react";
import { commands } from "./bindings";

/**
 * Placeholder screen that exercises the Rust <-> TypeScript bridge:
 * pasted TSV is parsed by the Rust core and the grid size is shown.
 */
export function App() {
  const [text, setText] = useState("");
  const [result, setResult] = useState<string | null>(null);

  async function handleParse() {
    const parsed = await commands.parseTsv(text);
    if (parsed.status === "ok") {
      const rows = parsed.data.length;
      const cols = parsed.data[0]?.length ?? 0;
      setResult(`${rows} rows × ${cols} columns`);
    } else {
      setResult(`Error: ${parsed.error.message}`);
    }
  }

  return (
    <main>
      <h1>db editor</h1>
      <p>Version {import.meta.env.APP_VERSION}</p>
      <label htmlFor="tsv-input">Paste TSV</label>
      <textarea id="tsv-input" value={text} onChange={(e) => setText(e.currentTarget.value)} />
      <button type="button" onClick={() => void handleParse()}>
        Parse
      </button>
      {result !== null && <output aria-live="polite">{result}</output>}
    </main>
  );
}
