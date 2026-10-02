import { MAX_NAME_LENGTH } from "../../shared/constants";

const KEY = "tb:name";

export function loadName(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveName(name: string): void {
  try {
    localStorage.setItem(KEY, name);
  } catch {
    // 保存できなくても毎回入力すれば遊べる
  }
}

export function cleanName(raw: string): string {
  return Array.from(raw.replace(/\s+/g, " ").trim()).slice(0, MAX_NAME_LENGTH).join("");
}

/** 合言葉の候補（覚えやすい ひらがな 2 語 + 数字） */
const WORDS = ["ねこ", "いぬ", "ぞう", "きりん", "かば", "ぱんだ", "らいおん", "うさぎ", "かめ", "ぺんぎん", "こあら", "わに"];
export function randomRoomCode(): string {
  const w = () => WORDS[Math.floor(Math.random() * WORDS.length)];
  return `${w()}${w()}${Math.floor(Math.random() * 90 + 10)}`;
}

export function roomUrl(code: string): string {
  return `${window.location.origin}/room/${encodeURIComponent(code)}`;
}
