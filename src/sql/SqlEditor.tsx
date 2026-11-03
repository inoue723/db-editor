import { PostgreSQL, sql, type SQLNamespace } from "@codemirror/lang-sql";
import { Compartment, EditorSelection, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { isMac } from "../lib/keys";

export interface EditorHandle {
  getText: () => string;
  setText: (text: string) => void;
  /** The selected text and its start, or `null` when nothing is selected. */
  getSelection: () => { text: string; from: number } | null;
  getCursor: () => number;
  /** Replaces the selection (or the whole text when nothing is selected). */
  replaceSelectionOrAll: (map: (text: string) => string) => void;
  moveCursor: (pos: number) => void;
  focus: () => void;
}

export interface EditorCommands {
  run: () => void;
  runAll: () => void;
  cancel: () => void;
  format: () => void;
  historyPrevious: () => void;
  historyNext: () => void;
}

interface Props {
  initialText: string;
  /** Tables and columns for completion. */
  schema: SQLNamespace;
  commands: EditorCommands;
  onChange: (text: string) => void;
}

/** CodeMirror 6 with PostgreSQL highlighting and schema-aware completion (spec 3.7). */
export const SqlEditor = forwardRef<EditorHandle, Props>(function SqlEditor(
  { initialText, schema, commands, onChange },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  // Key bindings call the latest callbacks without rebuilding the editor.
  const latest = useRef({ commands, onChange });
  latest.current = { commands, onChange };

  useEffect(() => {
    if (!host.current) {
      return undefined;
    }
    const run = (name: keyof EditorCommands) => () => {
      latest.current.commands[name]();
      return true;
    };
    // ^⌘←/→ on macOS; Ctrl+Alt+←/→ on Linux, where ⌘ and ^ both map to Ctrl.
    const historyMod = isMac ? "Ctrl-Mod" : "Ctrl-Alt";
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initialText,
        extensions: [
          Prec.highest(
            keymap.of([
              { key: "Mod-Enter", run: run("run") },
              { key: "Mod-Alt-Enter", run: run("runAll") },
              { key: "Mod-.", run: run("cancel") },
              { key: "Alt-Shift-f", run: run("format") },
              { key: `${historyMod}-ArrowLeft`, run: run("historyPrevious") },
              { key: `${historyMod}-ArrowRight`, run: run("historyNext") },
            ]),
          ),
          basicSetup,
          language.current.of(sql({ dialect: PostgreSQL, upperCaseKeywords: true })),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              latest.current.onChange(u.state.doc.toString());
            }
          }),
          EditorView.contentAttributes.of({ "aria-label": "SQL" }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // The editor is created once; text changes flow out through onChange.
    // oxlint-disable-next-line react/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({
      effects: language.current.reconfigure(
        sql({ dialect: PostgreSQL, schema, defaultSchema: "public", upperCaseKeywords: true }),
      ),
    });
  }, [schema]);

  useImperativeHandle(
    ref,
    () => ({
      getText: () => view.current?.state.doc.toString() ?? "",
      setText: (text) => {
        const v = view.current;
        v?.dispatch({
          changes: { from: 0, to: v.state.doc.length, insert: text },
          selection: { anchor: text.length },
        });
      },
      getSelection: () => {
        const v = view.current;
        const range = v?.state.selection.main;
        if (!v || !range || range.empty) {
          return null;
        }
        return { text: v.state.sliceDoc(range.from, range.to), from: range.from };
      },
      getCursor: () => view.current?.state.selection.main.head ?? 0,
      replaceSelectionOrAll: (map) => {
        const v = view.current;
        if (!v) {
          return;
        }
        const range = v.state.selection.main;
        const from = range.empty ? 0 : range.from;
        const to = range.empty ? v.state.doc.length : range.to;
        const insert = map(v.state.sliceDoc(from, to));
        v.dispatch({
          changes: { from, to, insert },
          selection: EditorSelection.range(from, from + insert.length),
        });
      },
      moveCursor: (pos) => {
        const v = view.current;
        if (!v) {
          return;
        }
        const anchor = Math.max(0, Math.min(pos, v.state.doc.length));
        v.dispatch({ selection: { anchor }, scrollIntoView: true });
        v.focus();
      },
      focus: () => view.current?.focus(),
    }),
    [],
  );

  return <div className="editor" ref={host} />;
});
