import type { Environment } from "../bindings";

export const ENVIRONMENTS: Environment[] = ["development", "staging", "production"];

export const ENV_LABEL: Record<Environment, string> = {
  development: "開発",
  staging: "ステージング",
  production: "本番",
};

/** Default connection color for each environment. */
export const ENV_COLOR: Record<Environment, string> = {
  development: "#2f8a57",
  staging: "#c08a1e",
  production: "#c8352b",
};

export const COLORS = ["#2f8a57", "#2f5fb3", "#c08a1e", "#c8352b", "#7a3fb5", "#566175"];

/** "5分前", "昨日" and so on, for the launcher cards. */
export function relativeTime(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) {
    return "未接続";
  }
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) {
    return "たった今";
  }
  if (minutes < 60) {
    return `${minutes}分前`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}時間前`;
  }
  const days = Math.floor(hours / 24);
  if (days === 1) {
    return "昨日";
  }
  if (days < 14) {
    return `${days}日前`;
  }
  if (days < 60) {
    return `${Math.floor(days / 7)}週間前`;
  }
  return `${Math.floor(days / 30)}か月前`;
}
