// shared-defaults.js ASR 预设与规范化测试：
// 验证 ASR_PROVIDER_PRESETS 字段齐全、normalizeAsrProvider type 合法值校验、
// DEFAULT_SETTINGS 新增的 4 个 ASR 默认项。

import { describe, expect, it } from "vitest";
import {
  ASR_PROVIDER_PRESETS,
  DEFAULT_SETTINGS,
  normalizeAsrProvider,
  getAsrPresetById
} from "../../extension/core/shared-defaults.js";

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
      expect(typeof p.maxBytes).toBe("number");
      expect(typeof p.maxDurationSec).toBe("number");
      expect(typeof p.supportsTimestamps).toBe("boolean");
      expect(typeof p.note).toBe("string");
    }
  });

  it("SiliconFlow 与本地 Whisper 同为 openai-transcriptions", () => {
    expect(getAsrPresetById("siliconflow-sensevoice").type).toBe("openai-transcriptions");
    expect(getAsrPresetById("local-whisper").type).toBe("openai-transcriptions");
  });

  it("SiliconFlow verbose_json 不支持，supportsTimestamps=false", () => {
    expect(getAsrPresetById("siliconflow-sensevoice").supportsTimestamps).toBe(false);
  });

  it("getAsrPresetById 未知 id 返回 null", () => {
    expect(getAsrPresetById("nonexistent")).toBeNull();
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
      maxBytes: 52428800,
      maxDurationSec: 3600,
      supportsTimestamps: false
    });
    expect(out).toEqual({
      id: "p1",
      presetId: "siliconflow-sensevoice",
      name: "我的 SiliconFlow",
      type: "openai-transcriptions",
      baseUrl: "https://api.siliconflow.cn/v1",
      model: "FunAudioLLM/SenseVoiceSmall",
      maxBytes: 52428800,
      maxDurationSec: 3600,
      supportsTimestamps: false,
      enabled: true
    });
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

  it("maxBytes / maxDurationSec 非数字回落 0（不限制）", () => {
    const out = normalizeAsrProvider({
      id: "p1",
      type: "openai-transcriptions",
      baseUrl: "x",
      model: "y",
      maxBytes: "abc",
      maxDurationSec: null
    });
    expect(out.maxBytes).toBe(0);
    expect(out.maxDurationSec).toBe(0);
  });
});

describe("DEFAULT_SETTINGS ASR 默认项", () => {
  it("asrProviders 默认空数组", () => {
    expect(DEFAULT_SETTINGS.asrProviders).toEqual([]);
  });
  it("activeAsrProviderId 默认空串", () => {
    expect(DEFAULT_SETTINGS.activeAsrProviderId).toBe("");
  });
  it("asrAutoFallback 默认 true（无字幕自动走 ASR）", () => {
    expect(DEFAULT_SETTINGS.asrAutoFallback).toBe(true);
  });
  it("asrChunkMinutes 默认 3", () => {
    expect(DEFAULT_SETTINGS.asrChunkMinutes).toBe(3);
  });
});
