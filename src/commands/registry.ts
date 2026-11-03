/**
 * Every operation as a command (spec 5.1). Menus, the palette and key bindings all
 * call commands by id; default keys follow Postico (spec 5.2).
 */

import { isMac } from "../lib/keys";

type Category = "全体" | "テーブル" | "SQL";

export interface CommandInfo {
  id: string;
  /** Japanese name, shown in menus and the palette. */
  title: string;
  /** English name; the palette matches both. */
  titleEn: string;
  category: Category;
  /** Default keys (see `keys.ts`). */
  keys: string[];
  /** When the default keys apply (see `when.ts`). */
  when?: string;
  /** Hidden from the palette (for example the tab-by-number commands). */
  hidden?: boolean;
}

/** Grid keys must not fire while typing in a text field or the SQL editor. */
const GRID = "focus == grid";
/** Table commands that also work from the toolbar, but not while typing. */
const TABLE = "tab == table && focus != input && focus != editor";
const EDITOR = "focus == editor";

const tabCommands: CommandInfo[] = Array.from({ length: 9 }, (_, i) => ({
  id: `app.selectTab${i + 1}`,
  title: i === 8 ? "最後のタブへ" : `${i + 1}番目のタブへ`,
  titleEn: i === 8 ? "Go to Last Tab" : `Go to Tab ${i + 1}`,
  category: "全体" as const,
  keys: [`mod+${i + 1}`],
  hidden: true,
}));

export const COMMANDS: CommandInfo[] = [
  // Global
  {
    id: "app.commandPalette",
    title: "コマンドパレット",
    titleEn: "Command Palette",
    category: "全体",
    keys: ["mod+shift+p"],
  },
  {
    id: "app.openQuickly",
    title: "テーブル・クエリへジャンプ",
    titleEn: "Open Quickly",
    category: "全体",
    keys: ["mod+p"],
  },
  {
    id: "app.openKeybindings",
    title: "キーボードショートカット",
    titleEn: "Keyboard Shortcuts",
    category: "全体",
    keys: ["mod+k mod+s"],
  },
  {
    id: "app.newTab",
    title: "新しいSQLタブ",
    titleEn: "New SQL Tab",
    category: "全体",
    keys: ["mod+t"],
  },
  {
    id: "app.closeTab",
    title: "タブを閉じる",
    titleEn: "Close Tab",
    category: "全体",
    keys: ["mod+w"],
  },
  ...tabCommands,
  {
    id: "app.toggleLeft",
    title: "左サイドバーの開閉",
    titleEn: "Toggle Left Sidebar",
    category: "全体",
    keys: ["mod+0"],
  },
  {
    id: "app.toggleRight",
    title: "右サイドバーの開閉",
    titleEn: "Toggle Right Sidebar",
    category: "全体",
    keys: ["mod+alt+0"],
  },
  {
    id: "app.reload",
    title: "再読み込み",
    titleEn: "Reload",
    category: "全体",
    keys: ["mod+r"],
  },
  {
    id: "app.filterTree",
    title: "サイドバーを絞り込む",
    titleEn: "Filter Sidebar",
    category: "全体",
    keys: ["mod+shift+f"],
  },
  {
    id: "app.undo",
    title: "元に戻す",
    titleEn: "Undo",
    category: "全体",
    keys: ["mod+z"],
    when: TABLE,
  },
  {
    id: "app.redo",
    title: "やり直す",
    titleEn: "Redo",
    category: "全体",
    keys: ["mod+shift+z"],
    when: TABLE,
  },

  // Table
  {
    id: "table.toggleView",
    title: "コンテンツ / 構造の切替",
    titleEn: "Toggle Content / Structure",
    category: "テーブル",
    keys: ["mod+alt+t"],
  },
  {
    id: "table.toggleFilter",
    title: "フィルタバー",
    titleEn: "Toggle Filter Bar",
    category: "テーブル",
    keys: ["mod+alt+f"],
  },
  {
    id: "table.insertRow",
    title: "行を追加",
    titleEn: "Insert Row",
    category: "テーブル",
    keys: ["mod+shift+n"],
    when: TABLE,
  },
  {
    id: "table.duplicateRow",
    title: "行を複製",
    titleEn: "Duplicate Row",
    category: "テーブル",
    keys: ["mod+d"],
    when: TABLE,
  },
  {
    id: "table.deleteRows",
    title: "行を削除",
    titleEn: "Delete Rows",
    category: "テーブル",
    keys: ["mod+backspace"],
    when: GRID,
  },
  {
    id: "table.setNull",
    title: "NULLを設定",
    titleEn: "Set NULL",
    category: "テーブル",
    keys: ["alt+backspace"],
    when: GRID,
  },
  {
    id: "table.setDefault",
    title: "DEFAULTに戻す",
    titleEn: "Set DEFAULT",
    category: "テーブル",
    keys: [],
    when: GRID,
  },
  {
    id: "table.save",
    title: "変更を保存",
    titleEn: "Save Changes",
    category: "テーブル",
    keys: ["mod+s"],
    when: "tab == table && focus != editor",
  },
  {
    id: "table.previewSave",
    title: "SQLをプレビューして保存",
    titleEn: "Preview SQL and Save",
    category: "テーブル",
    keys: ["mod+shift+s"],
    when: "tab == table && focus != editor",
  },
  {
    id: "table.discard",
    title: "変更を破棄",
    titleEn: "Discard Changes",
    category: "テーブル",
    keys: ["mod+shift+backspace"],
    when: TABLE,
  },
  {
    id: "table.paste",
    title: "ペースト",
    titleEn: "Paste",
    category: "テーブル",
    keys: ["mod+v"],
    when: GRID,
  },
  {
    id: "table.pasteByKey",
    title: "主キーで照合してペースト",
    titleEn: "Paste Matching Primary Key",
    category: "テーブル",
    keys: ["mod+shift+v"],
    when: GRID,
  },
  {
    id: "grid.followForeignKey",
    title: "外部キーの参照先へ",
    titleEn: "Follow Foreign Key",
    category: "テーブル",
    keys: ["mod+down"],
    when: GRID,
  },
  {
    id: "grid.copy",
    title: "コピー",
    titleEn: "Copy",
    category: "テーブル",
    keys: ["mod+c"],
    when: GRID,
  },
  {
    id: "grid.copyWithHeader",
    title: "ヘッダ付きでコピー",
    titleEn: "Copy with Header",
    category: "テーブル",
    keys: ["mod+shift+c"],
    when: GRID,
  },
  {
    id: "grid.copyAs",
    title: "形式を指定してコピー",
    titleEn: "Copy As…",
    category: "テーブル",
    keys: ["mod+alt+c"],
    when: GRID,
  },
  {
    id: "grid.selectAll",
    title: "すべて選択",
    titleEn: "Select All",
    category: "テーブル",
    keys: ["mod+a"],
    when: GRID,
  },

  // SQL
  {
    id: "sql.run",
    title: "カーソル位置の文を実行",
    titleEn: "Run Statement",
    category: "SQL",
    keys: ["mod+enter"],
    when: "tab == sql",
  },
  {
    id: "sql.runAll",
    title: "全て実行",
    titleEn: "Run All",
    category: "SQL",
    keys: ["mod+alt+enter"],
    when: "tab == sql",
  },
  {
    id: "sql.cancel",
    title: "クエリをキャンセル",
    titleEn: "Cancel Query",
    category: "SQL",
    keys: ["mod+."],
    when: "tab == sql",
  },
  {
    id: "sql.format",
    title: "SQLを整形",
    titleEn: "Format SQL",
    category: "SQL",
    keys: ["alt+shift+f"],
    when: "tab == sql",
  },
  {
    id: "sql.historyPrevious",
    title: "クエリ履歴の前",
    titleEn: "Previous Query in History",
    category: "SQL",
    // ^⌘← on macOS; Ctrl+Alt+← on Linux, where ⌘ and ^ are both Ctrl.
    keys: [isMac ? "mod+ctrl+left" : "mod+alt+left"],
    when: EDITOR,
  },
  {
    id: "sql.historyNext",
    title: "クエリ履歴の次",
    titleEn: "Next Query in History",
    category: "SQL",
    keys: [isMac ? "mod+ctrl+right" : "mod+alt+right"],
    when: EDITOR,
  },
  {
    id: "sql.save",
    title: "クエリを保存",
    titleEn: "Save Query",
    category: "SQL",
    keys: ["mod+s"],
    when: "tab == sql",
  },
];

export const COMMAND_BY_ID: ReadonlyMap<string, CommandInfo> = new Map(
  COMMANDS.map((c) => [c.id, c]),
);
