import { PostgreSQL, sql, type SQLNamespace } from "@codemirror/lang-sql";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

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

interface Props {
  initialText: string;
  /** Tables and columns for completion. */
  schema: SQLNamespace;
  onChange: (text: string) => void;
}

/**
 * CodeMirror 6 with PostgreSQL highlighting and schema-aware completion (spec 3.7).
 * Run, format and history keys are commands (`sql.*`), so they can be rebound.
 */
export const SqlEditor = forwardRef<EditorHandle, Props>(function SqlEditor(
  { initialText, schema, onChange },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  // The listener calls the latest callback without rebuilding the editor.
  const latest = useRef({ onChange });
  latest.current = { onChange };

  useEffect(() => {
    if (!host.current) {
      return undefined;
    }
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initialText,
        extensions: [
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
