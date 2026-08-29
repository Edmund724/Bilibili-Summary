// ui/markdown splitMarkdownTail 单测：流式"稳定前缀 + 末块"增量渲染的切分
// 纯函数边界行为（最后一个空行边界 + 围栏闭合约束 + 安全退化）。

import { describe, expect, it } from "vitest";
import { renderMarkdown, splitMarkdownTail } from "../../extension/ui/markdown.js";

describe("splitMarkdownTail", () => {
  it("常规多段文本：在最后一个空行边界切分，stable + tail 堆叠渲染与全文渲染一致", () => {
    const { stableText, tailText } = splitMarkdownTail("第一段\n\n第二段开头");
    expect(stableText).toBe("第一段");
    expect(tailText).toBe("\n第二段开头");
    expect(renderMarkdown(stableText) + renderMarkdown(tailText)).toBe(renderMarkdown("第一段\n\n第二段开头"));
  });

  it("围栏完整闭合于前缀 → 正常切分（代码块留在 stable），堆叠渲染与全文一致", () => {
    const text = "说明\n\n```js\nconst a = 1;\n```\n\n后续段落";
    const { stableText, tailText } = splitMarkdownTail(text);
    expect(stableText).toBe("说明\n\n```js\nconst a = 1;\n```");
    expect(tailText).toBe("\n后续段落");
    expect(renderMarkdown(stableText)).toContain("<pre><code>");
    expect(renderMarkdown(stableText) + renderMarkdown(tailText)).toBe(renderMarkdown(text));
  });

  it("空行切点落在未闭合围栏内 → 切点前移到围栏之前的边界，围栏整段留在 tail", () => {
    const text = "第一段\n\n```js\n\n围栏内空行\n\n仍在围栏";
    const { stableText, tailText } = splitMarkdownTail(text);
    expect(stableText).toBe("第一段");
    expect(tailText).toBe("\n```js\n\n围栏内空行\n\n仍在围栏");
    expect(renderMarkdown(stableText) + renderMarkdown(tailText)).toBe(renderMarkdown(text));
  });

  it("所有空行边界都落在未闭合围栏内 → 安全退化为全 tail", () => {
    const text = "```js\n\n围栏内空行\n\n仍在围栏";
    expect(splitMarkdownTail(text)).toEqual({ stableText: "", tailText: text });
  });

  it("全文无空行 → 全 tail（等价今天的行为）", () => {
    const text = "# 标题\n- 项目一\n- 项目二";
    expect(splitMarkdownTail(text)).toEqual({ stableText: "", tailText: text });
  });

  it("仅文末换行（尾随空行）不构成切点 → 全 tail，stable 不随尾随空行抖动", () => {
    const text = "第一段\n";
    expect(splitMarkdownTail(text)).toEqual({ stableText: "", tailText: text });
    const grown = "第一段\n\n第二段";
    // 追加正文后同一边界重新可用，且 stable 取值不含尾随空行
    expect(splitMarkdownTail(grown)).toEqual({ stableText: "第一段", tailText: "\n第二段" });
  });

  it("表格（单换行分隔）整块留在 tail，表头与分隔行不被切开", () => {
    const text = "前言\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |";
    const { stableText, tailText } = splitMarkdownTail(text);
    expect(stableText).toBe("前言");
    expect(tailText).toBe("\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |");
    expect(renderMarkdown(tailText)).toContain("<table>");
  });

  it("列表（单换行分隔）整块留在 tail", () => {
    const text = "前言\n\n- 项目一\n- 项目二\n- 项目三";
    const { stableText, tailText } = splitMarkdownTail(text);
    expect(stableText).toBe("前言");
    expect(tailText).toBe("\n- 项目一\n- 项目二\n- 项目三");
    expect(renderMarkdown(tailText)).toContain("<ul>");
  });

  it("连续空行按一个边界处理", () => {
    const { stableText, tailText } = splitMarkdownTail("第一段\n\n\n\n第二段");
    expect(stableText).toBe("第一段");
    expect(tailText).toBe("\n\n\n第二段");
  });

  it("空串 / 全空行 / null → 空 stable + 原文 tail", () => {
    expect(splitMarkdownTail("")).toEqual({ stableText: "", tailText: "" });
    expect(splitMarkdownTail("\n\n")).toEqual({ stableText: "", tailText: "\n\n" });
    expect(splitMarkdownTail(null)).toEqual({ stableText: "", tailText: "" });
  });
});
