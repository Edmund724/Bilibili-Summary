// presets.js / defaults.js ASR 预设与规范化测试：
// 验证 ASR_PROVIDER_PRESETS 字段齐全、normalizeAsrProvider type 合法值校验、
// DEFAULT_SETTINGS 的 3 个 ASR 标量默认项（asrProviders 列表已摘出 settings，
// 归 provider-store 管）。

import { describe, expect, it } from "vitest";
import { ASR_PROVIDER_PRESETS, normalizeAsrProvider, normalizeAsrLanguage } from "../../extension/core/presets.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";

// 本地查找助手：生产代码没有按 id 查预设的导出（按需直接遍历预设表）。
const presetById = (id) => ASR_PROVIDER_PRESETS.find((p) => p.id === id) || null;

describe("ASR_PROVIDER_PRESETS", () => {
  it("包含三个内置预设（SiliconFlow/本地 Whisper/自定义）", () => {
    const ids = ASR_PROVIDER_PRESETS.map((p) => p.id);
    expect(ids).toEqual([
      "siliconflow-sensevoice",
      "local-whisper",
      "custom"
    ]);
  });

  it("每个预设字段齐全且 type 为合法值之一", () => {
    const validTypes = new Set(["openai-transcriptions"]);
    for (const p of ASR_PROVIDER_PRESETS) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(validTypes.has(p.type)).toBe(true);
      expect(typeof p.baseUrl).toBe("string");
      expect(typeof p.model).toBe("string");
      expect(typeof p.supportsTimestamps).toBe("boolean");
      expect(typeof p.note).toBe("string");
    }
  });

  it("SiliconFlow 与本地 Whisper 同为 openai-transcriptions", () => {
    expect(presetById("siliconflow-sensevoice").type).toBe("openai-transcriptions");
    expect(presetById("local-whisper").type).toBe("openai-transcriptions");
  });

  it("SiliconFlow 已支持返回时间戳，supportsTimestamps=true", () => {
    expect(presetById("siliconflow-sensevoice").supportsTimestamps).toBe(true);
  });

  it("SiliconFlow 提供 4 个 ASR 模型下拉选项（Qwen3 标明收费）", () => {
    const sf = presetById("siliconflow-sensevoice");
    expect(Array.isArray(sf.modelOptions)).toBe(true);
    expect(sf.modelOptions.map((o) => o.value)).toEqual([
      "Qwen/Qwen3-ASR-1.7B",
      "XingChenAGI/XingChenASR-V3.2",
      "XingChenAGI/XingChenASR-Diarize-V3.0",
      "XingChenAGI/XingChenASR-V3.2-Ultra"
    ]);
    expect(sf.modelOptions[0].label).toContain("收费");
    // 默认 model 必须是有效下拉选项，保证新建行下拉框有默认选中项
    expect(sf.modelOptions.some((o) => o.value === sf.model)).toBe(true);
  });
});

describe("normalizeAsrProvider", () => {
  it("完整 provider 原样保留关键字段并补 enabled 默认 true", () => {
    const out = normalizeAsrProvider({
      id: "p1",
      presetId: "siliconflow-sensevoice",
      name: "我的 SiliconFlow",
      type: "openai-transcriptions",
      baseUrl: "https://api.siliconflow.cn/v1/",
      model: "FunAudioLLM/SenseVoiceSmall",
      supportsTimestamps: false
    });
    expect(out).toEqual({
      id: "p1",
      presetId: "siliconflow-sensevoice",
      name: "我的 SiliconFlow",
      type: "openai-transcriptions",
      baseUrl: "https://api.siliconflow.cn/v1",
      model: "FunAudioLLM/SenseVoiceSmall",
      supportsTimestamps: false,
      enabled: true
    });
  });

  it("language 归 normalizeAsrLanguage 管：normalizeAsrProvider 不保留该字段", () => {
    const out = normalizeAsrProvider({
      id: "p1", type: "openai-transcriptions", baseUrl: "x", model: "y", language: "en"
    });
    expect(out.language).toBeUndefined();
  });

  it("normalizeAsrLanguage：zh/en 保留，其余回落 auto", () => {
    expect(normalizeAsrLanguage("zh")).toBe("zh");
    expect(normalizeAsrLanguage("en")).toBe("en");
    expect(normalizeAsrLanguage("EN")).toBe("en");
    expect(normalizeAsrLanguage("auto")).toBe("auto");
    // 缺失 / 非法值都回落 auto
    expect(normalizeAsrLanguage("")).toBe("auto");
    expect(normalizeAsrLanguage(undefined)).toBe("auto");
    expect(normalizeAsrLanguage("ja")).toBe("auto");
  });

  it("baseUrl 尾部斜杠被剥离", () => {
    const out = normalizeAsrProvider({
      id: "p1",
      type: "openai-transcriptions",
      baseUrl: "http://localhost:8000/v1///",
      model: "whisper-1"
    });
    expect(out.baseUrl).toBe("http://localhost:8000/v1");
  });

  it("非法 type 返回 null（不静默接受任意 type）", () => {
    expect(
      normalizeAsrProvider({ id: "p1", type: "random-protocol", baseUrl: "x", model: "y" })
    ).toBeNull();
    expect(
      normalizeAsrProvider({ id: "p1", type: "", baseUrl: "x", model: "y" })
    ).toBeNull();
    expect(
      normalizeAsrProvider({ id: "p1", type: "openai_chat", baseUrl: "x", model: "y" })
    ).toBeNull();
  });

  it("缺失 id 返回 null", () => {
    expect(normalizeAsrProvider({ type: "openai-transcriptions", baseUrl: "x", model: "y" })).toBeNull();
    expect(normalizeAsrProvider({ id: "  ", type: "openai-transcriptions" })).toBeNull();
    expect(normalizeAsrProvider(null)).toBeNull();
    expect(normalizeAsrProvider("string")).toBeNull();
  });

  it("supportsTimestamps 缺失时默认 true（自定义预设自动探测语义）", () => {
    const out = normalizeAsrProvider({
      id: "p1",
      type: "openai-transcriptions",
      baseUrl: "x",
      model: "y"
    });
    expect(out.supportsTimestamps).toBe(true);
  });

  it("enabled 显式 false 被保留，非 false 值回落 true", () => {
    const enabled = normalizeAsrProvider({
      id: "p1", type: "openai-transcriptions", baseUrl: "x", model: "y", enabled: false
    });
    expect(enabled.enabled).toBe(false);

    const enabledTruthy = normalizeAsrProvider({
      id: "p2", type: "openai-transcriptions", baseUrl: "x", model: "y", enabled: "yes"
    });
    expect(enabledTruthy.enabled).toBe(true);
  });
});

describe("DEFAULT_SETTINGS ASR 默认项", () => {
  it("asrProviders 不再是设置默认项（provider 列表归 provider-store）", () => {
    expect(DEFAULT_SETTINGS).not.toHaveProperty("asrProviders");
  });
  it("activeAsrProviderId 默认空串", () => {
    expect(DEFAULT_SETTINGS.activeAsrProviderId).toBe("");
  });
  it("asrAutoFallback 默认 true（无字幕自动走 ASR）", () => {
    expect(DEFAULT_SETTINGS.asrAutoFallback).toBe(true);
  });
  it("asrLanguage 默认 auto（自动检测语言）", () => {
    expect(DEFAULT_SETTINGS.asrLanguage).toBe("auto");
  });
});
