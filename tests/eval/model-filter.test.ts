// model-filter 单测：wanted ∩ data[].id、保序、形状容错、精确匹配。

import { describe, expect, it } from "vitest";
import { filterAvailableModels } from "../../eval/lib/model-filter.js";

describe("filterAvailableModels", () => {
  it("返回 wanted 中出现在 data[].id 的模型，保序", () => {
    const response = {
      data: [{ id: "FunAudioLLM/SenseVoiceSmall" }, { id: "openai/whisper-tiny" }, { id: "other" }]
    };
    expect(
      filterAvailableModels(response, ["openai/whisper-tiny", "not-there", "FunAudioLLM/SenseVoiceSmall"])
    ).toEqual(["openai/whisper-tiny", "FunAudioLLM/SenseVoiceSmall"]);
  });

  it("wanted 顺序为准，即使 data 顺序不同", () => {
    const response = { data: [{ id: "b" }, { id: "a" }] };
    expect(filterAvailableModels(response, ["a", "b"])).toEqual(["a", "b"]);
  });

  it("id 精确匹配（前缀/大小写不算）", () => {
    const response = { data: [{ id: "whisper-tiny" }] };
    expect(filterAvailableModels(response, ["whisper", "WHISPER-TINY", "whisper-tiny"])).toEqual([
      "whisper-tiny"
    ]);
  });

  it("data 缺失 / 非数组 / 顶层非对象 → []", () => {
    expect(filterAvailableModels({}, ["a"])).toEqual([]);
    expect(filterAvailableModels({ data: "nope" }, ["a"])).toEqual([]);
    expect(filterAvailableModels(null, ["a"])).toEqual([]);
    expect(filterAvailableModels("string", ["a"])).toEqual([]);
  });

  it("wanted 为空 → []", () => {
    expect(filterAvailableModels({ data: [{ id: "a" }] }, [])).toEqual([]);
  });

  it("data 元素缺 id 或非对象时跳过", () => {
    const response = { data: [{ id: "a" }, {}, null, { id: 42 }] };
    expect(filterAvailableModels(response, ["a"])).toEqual(["a"]);
  });
});
