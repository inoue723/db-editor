import { useEffect, useState } from "react";
import {
  commands,
  type ConnectionProfile_Deserialize,
  type ConnectionProfile_Serialize,
  type Environment,
  type PasswordUpdate,
  type SslMode,
} from "../bindings";
import { call, errorMessage } from "../lib/api";
import { COLORS, ENV_COLOR, ENV_LABEL, ENVIRONMENTS } from "../lib/env";
import { Modal } from "../ui/Modal";

type Profile = ConnectionProfile_Serialize;

const SSL_MODES: SslMode[] = ["disable", "prefer", "require", "verify-ca", "verify-full"];
const TABS = ["一般", "SSL"] as const;

interface Form {
  name: string;
  color: string;
  environment: Environment;
  group: string;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  readOnly: boolean;
  sslMode: SslMode;
  rootCert: string;
  clientCert: string;
  clientKey: string;
}

function toForm(p: Profile | null): Form {
  return {
    name: p?.name ?? "",
    color: p?.color ?? ENV_COLOR.development,
    environment: p?.environment ?? "development",
    group: p?.group ?? "",
    host: p?.host ?? "",
    port: String(p?.port ?? 5432),
    database: p?.database ?? "postgres",
    user: p?.user ?? "postgres",
    password: "",
    readOnly: p?.readOnly ?? false,
    sslMode: p?.ssl.mode ?? "prefer",
    rootCert: p?.ssl.rootCert ?? "",
    clientCert: p?.ssl.clientCert ?? "",
    clientKey: p?.ssl.clientKey ?? "",
  };
}

function toProfile(id: string, f: Form, lastUsedAt: number | null): ConnectionProfile_Deserialize {
  return {
    id,
    name: f.name.trim(),
    color: f.color,
    environment: f.environment,
    group: f.group.trim(),
    host: f.host.trim(),
    port: Number(f.port) || 5432,
    database: f.database.trim() || "postgres",
    user: f.user.trim(),
    readOnly: f.readOnly,
    ssl: {
      mode: f.sslMode,
      rootCert: f.rootCert.trim() || null,
      clientCert: f.clientCert.trim() || null,
      clientKey: f.clientKey.trim() || null,
    },
    lastUsedAt,
  };
}

type TestState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; text: string }
  | { kind: "error"; text: string };

interface Props {
  /** The profile to edit, or `null` for a new one. A profile with an empty id is a copy. */
  initial: Profile | null;
  groups: string[];
  onClose: () => void;
  onSaved: (profile: Profile, connect: boolean) => void | Promise<void>;
}

/** Create or edit a connection (spec 3.2). */
export function ConnectionDialog({ initial, groups, onClose, onSaved }: Props) {
  const existingId = initial?.id ?? "";
  const [form, setForm] = useState<Form>(() => toForm(initial));
  const [tab, setTab] = useState<(typeof TABS)[number]>("一般");
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [hasPassword, setHasPassword] = useState(false);
  const [clearPassword, setClearPassword] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (existingId) {
      void call(commands.hasSavedPassword(existingId)).then(setHasPassword, () =>
        setHasPassword(false),
      );
    }
  }, [existingId]);

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setTest({ kind: "idle" });
  }

  function setEnvironment(env: Environment) {
    setForm((f) => ({
      ...f,
      environment: env,
      // Production opens read-only unless the user turns it off (spec 3.2).
      readOnly: env === "production" ? true : f.readOnly,
      color: Object.values(ENV_COLOR).includes(f.color) ? ENV_COLOR[env] : f.color,
    }));
  }

  async function applyUrl(value: string) {
    setUrl(value);
    if (!value.trim()) {
      setUrlError(null);
      return;
    }
    try {
      const parsed = await call(commands.parseConnectionUrl(value));
      setUrlError(null);
      setForm((f) => ({
        ...f,
        host: parsed.host ?? f.host,
        port: parsed.port ? String(parsed.port) : "5432",
        database: parsed.database ?? "postgres",
        user: parsed.user ?? f.user,
        password: parsed.password ?? f.password,
        sslMode: SSL_MODES.find((m) => m === parsed.sslMode) ?? f.sslMode,
        name: f.name || parsed.database || parsed.host || "",
      }));
    } catch (e) {
      setUrlError(errorMessage(e));
    }
  }

  function passwordUpdate(): PasswordUpdate {
    if (form.password) {
      return { kind: "set", value: form.password };
    }
    if (clearPassword) {
      return { kind: "clear" };
    }
    return existingId ? { kind: "keep" } : { kind: "clear" };
  }

  async function runTest() {
    setTest({ kind: "running" });
    try {
      // Without a typed password, Rust uses the stored one of an existing profile.
      const result = await call(
        commands.testConnection(
          toProfile(clearPassword ? "" : existingId, form, null),
          form.password || null,
        ),
      );
      setTest({
        kind: "ok",
        text: `接続できました · PostgreSQL ${result.serverVersion} · ${result.elapsedMs} ms`,
      });
    } catch (e) {
      setTest({ kind: "error", text: errorMessage(e) });
    }
  }

  async function save(connect: boolean) {
    setSaving(true);
    setError(null);
    try {
      const saved = await call(
        commands.saveConnection(
          toProfile(existingId, form, initial?.lastUsedAt ?? null),
          passwordUpdate(),
        ),
      );
      await onSaved(saved, connect);
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  }

  const canSave = form.name.trim() !== "" && form.host.trim() !== "" && !saving;

  return (
    <Modal
      title={existingId ? "接続を編集" : "新しい接続"}
      onClose={onClose}
      header={
        <div className="mtabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
      }
      footer={
        <>
          <output
            className={`res ${test.kind === "ok" ? "ok" : test.kind === "error" || error ? "err" : ""}`}
            title={test.kind === "error" ? test.text : undefined}
          >
            {error ??
              (test.kind === "running" ? "接続しています…" : test.kind === "idle" ? "" : test.text)}
          </output>
          <button
            type="button"
            className="sbtn"
            onClick={() => void runTest()}
            disabled={!form.host.trim() || test.kind === "running"}
          >
            接続テスト
          </button>
          <button type="button" className="sbtn" onClick={onClose}>
            キャンセル
          </button>
          <button
            type="button"
            className="sbtn"
            onClick={() => void save(false)}
            disabled={!canSave}
          >
            保存
          </button>
          <button
            type="button"
            className="pbtn"
            onClick={() => void save(true)}
            disabled={!canSave}
          >
            保存して接続
          </button>
        </>
      }
    >
      {tab === "一般" ? (
        <div className="mbody">
          <div className="urlbox">
            <span className="kbd">URL</span>
            <input
              aria-label="接続URL"
              placeholder="postgres://user:pass@host:5432/db を貼り付けると下の欄に入ります"
              value={url}
              onChange={(e) => void applyUrl(e.currentTarget.value)}
            />
          </div>
          {urlError && <div className="hint err">{urlError}</div>}
          <label htmlFor="f-name">名前</label>
          <input
            type="text"
            id="f-name"
            value={form.name}
            placeholder="shop-dev"
            onChange={(e) => set("name", e.currentTarget.value)}
          />
          <span className="flabel">色</span>
          <div className="colors">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                style={{ background: c }}
                aria-pressed={form.color === c}
                aria-label={`色 ${c}`}
                onClick={() => set("color", c)}
              />
            ))}
          </div>
          <span className="flabel">環境ラベル</span>
          <div>
            <div className="seg envseg">
              {ENVIRONMENTS.map((env) => (
                <button
                  key={env}
                  type="button"
                  data-env={env}
                  aria-pressed={form.environment === env}
                  onClick={() => setEnvironment(env)}
                >
                  {ENV_LABEL[env]}
                </button>
              ))}
            </div>
          </div>
          {form.environment === "production" && (
            <div className="hint">
              本番ではウィンドウ上端に赤い帯が出ます。読み取り専用を既定でONにします。
            </div>
          )}
          <label htmlFor="f-group">グループ</label>
          <input
            type="text"
            id="f-group"
            list="f-groups"
            value={form.group}
            placeholder="仕事、個人 など(任意)"
            onChange={(e) => set("group", e.currentTarget.value)}
          />
          <datalist id="f-groups">
            {groups.map((g) => (
              <option key={g} value={g} aria-label={g} />
            ))}
          </datalist>
          <label htmlFor="f-host">ホスト / ポート</label>
          <div className="row2">
            <input
              type="text"
              id="f-host"
              value={form.host}
              placeholder="localhost"
              onChange={(e) => set("host", e.currentTarget.value)}
            />
            <input
              type="text"
              aria-label="ポート"
              inputMode="numeric"
              value={form.port}
              style={{ width: 80 }}
              onChange={(e) => set("port", e.currentTarget.value.replace(/\D/g, ""))}
            />
          </div>
          <label htmlFor="f-db">データベース</label>
          <input
            type="text"
            id="f-db"
            value={form.database}
            placeholder="postgres"
            onChange={(e) => set("database", e.currentTarget.value)}
          />
          <label htmlFor="f-user">ユーザー</label>
          <input
            type="text"
            id="f-user"
            value={form.user}
            placeholder="postgres"
            onChange={(e) => set("user", e.currentTarget.value)}
          />
          <label htmlFor="f-pw">パスワード</label>
          <input
            type="password"
            id="f-pw"
            value={form.password}
            placeholder={hasPassword && !clearPassword ? "保存済み(変更するときだけ入力)" : ""}
            onChange={(e) => set("password", e.currentTarget.value)}
          />
          <div className="hint">
            パスワードは{" "}
            {navigator.userAgent.includes("Mac")
              ? "macOS キーチェーン"
              : "Secret Service(GNOME Keyring など)"}{" "}
            に保存し、設定ファイルには書きません。
            {hasPassword && !form.password && (
              <>
                {" "}
                <label>
                  <input
                    type="checkbox"
                    checked={clearPassword}
                    onChange={(e) => setClearPassword(e.currentTarget.checked)}
                  />{" "}
                  保存済みのパスワードを削除
                </label>
              </>
            )}
          </div>
          <span className="flabel">読み取り専用</span>
          <button
            type="button"
            className="switch"
            role="switch"
            aria-checked={form.readOnly}
            aria-label="読み取り専用"
            onClick={() => set("readOnly", !form.readOnly)}
          >
            <i />
            <span>{form.readOnly ? "ON: 書き込み系のSQLはサーバーが拒否します" : "OFF"}</span>
          </button>
        </div>
      ) : (
        <div className="mbody">
          <label htmlFor="f-ssl">SSLモード</label>
          <select
            id="f-ssl"
            value={form.sslMode}
            onChange={(e) => {
              const value = e.currentTarget.value;
              const mode = SSL_MODES.find((m) => m === value);
              if (mode) {
                set("sslMode", mode);
              }
            }}
          >
            {SSL_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <div className="hint">
            prefer / require は証明書を検証しません。verify-ca は認証局を、verify-full
            はさらにホスト名を検証します。
          </div>
          <label htmlFor="f-ca">CA証明書</label>
          <input
            type="text"
            id="f-ca"
            value={form.rootCert}
            placeholder="未指定ならシステムの証明書ストア"
            onChange={(e) => set("rootCert", e.currentTarget.value)}
          />
          <label htmlFor="f-cert">クライアント証明書</label>
          <input
            type="text"
            id="f-cert"
            value={form.clientCert}
            placeholder="/path/to/client.crt(PEM)"
            onChange={(e) => set("clientCert", e.currentTarget.value)}
          />
          <label htmlFor="f-key">クライアント鍵</label>
          <input
            type="text"
            id="f-key"
            value={form.clientKey}
            placeholder="/path/to/client.key(PEM)"
            onChange={(e) => set("clientKey", e.currentTarget.value)}
          />
        </div>
      )}
    </Modal>
  );
}
