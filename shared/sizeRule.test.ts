import { describe, expect, it } from "vitest";
import {
  computeUpscaleFactor,
  evaluateSize,
  rollSizeRequirement,
  SIZE_CLASSES,
  sizeRequirementOf,
} from "./sizeRule";

const LARGE = sizeRequirementOf("LARGE");

describe("rollSizeRequirement", () => {
  it("乱数値に応じて重みどおりのクラスを返す", () => {
    // 重み 35 / 40 / 25 → 境界 0.35, 0.75
    expect(rollSizeRequirement(() => 0).class).toBe("SMALL");
    expect(rollSizeRequirement(() => 0.349).class).toBe("SMALL");
    expect(rollSizeRequirement(() => 0.35).class).toBe("MEDIUM");
    expect(rollSizeRequirement(() => 0.749).class).toBe("MEDIUM");
    expect(rollSizeRequirement(() => 0.75).class).toBe("LARGE");
    expect(rollSizeRequirement(() => 0.9999).class).toBe("LARGE");
  });

  it("返り値は表示用メタ情報を含まないプロトコル形", () => {
    expect(rollSizeRequirement(() => 0.5)).toEqual({ class: "MEDIUM", minWidth: 120, minHeight: 120, minPixels: 5000 });
  });

  it("全クラスで面積下限が外接枠より十分小さい", () => {
    for (const c of Object.values(SIZE_CLASSES)) expect(c.minPixels).toBeLessThan(c.minWidth * c.minHeight * 0.5);
  });
});

describe("evaluateSize", () => {
  it("直径 190 の円は LARGE を満たす", () => {
    const r = 95;
    expect(evaluateSize({ width: 190, height: 190, area: Math.PI * r * r }, LARGE).ok).toBe(true);
  });

  it("L 字（190 角・太さ 60）は LARGE を満たす", () => {
    expect(evaluateSize({ width: 190, height: 190, area: 190 * 60 * 2 - 60 * 60 }, LARGE).ok).toBe(true);
  });

  it("細い棒（220×12）は長辺は足りても面積で落ちる", () => {
    const e = evaluateSize({ width: 220, height: 12, area: 220 * 12 }, LARGE);
    expect(e.sideOk).toBe(true);
    expect(e.areaOk).toBe(false);
    expect(e.ok).toBe(false);
  });

  it("横長の塊（200×60）は長辺ルールで通る", () => {
    expect(evaluateSize({ width: 200, height: 60, area: 200 * 60 }, LARGE).ok).toBe(true);
  });

  it("小さな点は SMALL でも落ちる", () => {
    expect(evaluateSize({ width: 10, height: 10, area: 80 }, sizeRequirementOf("SMALL")).ok).toBe(false);
  });
});

describe("computeUpscaleFactor", () => {
  it("拡大後は規定を満たす", () => {
    const m = { width: 60, height: 50, area: 2400 };
    const f = computeUpscaleFactor(m, LARGE, 256);
    expect(evaluateSize({ width: m.width * f, height: m.height * f, area: m.area * f * f }, LARGE).ok).toBe(true);
  });

  it("面積が足りない場合は面積基準で拡大する", () => {
    // 長辺 200 は OK だが面積 4000 < 11000
    const f = computeUpscaleFactor({ width: 200, height: 40, area: 4000 }, LARGE, 1000);
    expect(f).toBeGreaterThanOrEqual(Math.sqrt(11000 / 4000));
  });

  it("キャンバスに収まる倍率で頭打ちになる", () => {
    const f = computeUpscaleFactor({ width: 200, height: 20, area: 2000 }, LARGE, 256);
    expect(200 * f).toBeLessThanOrEqual(256);
  });

  it("既に満たしていれば 1 以上の小さな倍率", () => {
    const f = computeUpscaleFactor({ width: 200, height: 200, area: 30000 }, LARGE, 256);
    expect(f).toBeGreaterThanOrEqual(1);
    expect(f).toBeLessThan(1.1);
  });
});
