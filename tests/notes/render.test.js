// notes/render.ts 直测（arch-slim-2/05 测试网）。
//
// 被测函数全部是纯函数（无 DOM/chrome 依赖；cleanVideoUrl 读 location.href，
// beforeEach 统一钉在标准视频 URL），零注入成本直测。覆盖：
// - buildSubtitleSectionLines 章节分桶四要素（工单 acceptance 逐条参数化）：
//   浮点容差（from + 0.001 >= start）/ 章界取下一章 from /「### 其他片段」兜底 /
//   末尾空行裁剪。该函数同时被 ai/subtitle-prompt.ts 消费——输出即发给模型的
//   prompt 字节，断言冻结意义双份（改动即 prompt 漂移，必须显式过门）；
// - buildMarkdown 逐段断言：frontmatter 模板 / 占位节 / 评论节（工单原文的
//   「hasFinalNote 联动」在当前树中已不存在同名分支，评论节的
//   includeHotCommentsInNote 门控即该联动点的现存形态，见票 Comments）；
// - buildTxt / buildSrt / buildSubtitlePreview / shouldShowHoursInNote
//   （三输入 max 口径：字幕 maxTo、章节 max(from,to)、meta.videoDuration）。

import { beforeEach, describe, expect, it } from "vitest";
import { setLocationUrl, NORMAL_PAGE_URL } from "../setup.js";

import {
  buildMarkdown,
  buildSrt,
  buildSubtitlePreview,
  buildSubtitleSectionLines,
  buildTxt,
  shouldShowHoursInNote
} from "../../extension/notes/render.js";

const body = (items) => items.map((item) => ({ from: 0, to: 5, content: "x", ...item }));

beforeEach(() => {
  setLocationUrl(NORMAL_PAGE_URL);
});

// ===== buildSubtitleSectionLines：章节分桶游标算法 =====

describe("buildSubtitleSectionLines：章节分桶四要素", () => {
  const tsOn = { includeTimestampInBody: true };

  it("要素1 浮点容差：from + 0.001 >= start 的字幕归入本章（4.9995 → start=5）", () => {
    const lines = buildSubtitleSectionLines(
      body([{ from: 4.9995, content: "边界句" }]),
      [{ title: "第一章", from: 5, to: 100 }],
      tsOn,
      false
    );

    // 不带容差会因 4.9995 < 5 被游标跳过，落到「其他片段」
    expect(lines).toContain("### 第一章 `0:05`");
    expect(lines.some((line) => line.includes("边界句"))).toBe(true);
    expect(lines).not.toContain("### 其他片段");
  });

  it("要素1 对照：from 与 start 相差超过容差（4.99 → start=5）被跳过，落入其他片段", () => {
    const lines = buildSubtitleSectionLines(
      body([{ from: 4.99, content: "上一章句" }]),
      [{ title: "第一章", from: 5, to: 100 }],
      tsOn,
      false
    );

    expect(lines).not.toContain("### 第一章 `0:05`");
    expect(lines).toContain("### 其他片段");
    expect(lines.some((line) => line.includes("上一章句"))).toBe(true);
  });

  it("要素2 章界取下一章 from：from=9.5 归第一章、from=10 起归第二章", () => {
    const lines = buildSubtitleSectionLines(
      body([
        { from: 9.5, content: "章一末句" },
        { from: 10, content: "章二首句" },
        { from: 12, content: "章二中句" }
      ]),
      [
        { title: "第一章", from: 0, to: 10 },
        { title: "第二章", from: 10, to: 20 }
      ],
      tsOn,
      false
    );

    const firstStart = lines.indexOf("### 第一章 `0:00`");
    const secondStart = lines.indexOf("### 第二章 `0:10`");
    expect(firstStart).toBeGreaterThan(-1);
    expect(secondStart).toBeGreaterThan(firstStart);

    const firstChunk = lines.slice(firstStart, secondStart);
    const secondChunk = lines.slice(secondStart);
    expect(firstChunk.some((line) => line.includes("章一末句"))).toBe(true);
    expect(firstChunk.some((line) => line.includes("章二首句"))).toBe(false);
    expect(secondChunk.some((line) => line.includes("章二首句"))).toBe(true);
    expect(secondChunk.some((line) => line.includes("章二中句"))).toBe(true);
  });

  it("要素2 末章无下一章时章界回退本章 to：to 之后（from=11 > to=10）的字幕不归本章", () => {
    const lines = buildSubtitleSectionLines(
      body([{ from: 11, content: "章后句" }]),
      [{ title: "第一章", from: 0, to: 10 }],
      tsOn,
      false
    );

    expect(lines).not.toContain("### 第一章 `0:00`");
    expect(lines).toContain("### 其他片段");
    expect(lines.some((line) => line.includes("章后句"))).toBe(true);
  });

  it("要素3 兜底：首章 start 之前的字幕归入「### 其他片段」，且排在章节段之后", () => {
    const lines = buildSubtitleSectionLines(
      body([
        { from: 0, content: "片头句" },
        { from: 12, content: "章内句" }
      ]),
      [{ title: "第一章", from: 10, to: 20 }],
      tsOn,
      false
    );

    const otherStart = lines.indexOf("### 其他片段");
    expect(otherStart).toBeGreaterThan(-1);
    expect(lines.indexOf("### 第一章 `0:10`")).toBeGreaterThan(-1);
    expect(lines.indexOf("### 第一章 `0:10`")).toBeLessThan(otherStart);
    const otherChunk = lines.slice(otherStart);
    expect(otherChunk.some((line) => line.includes("片头句"))).toBe(true);
    expect(otherChunk.some((line) => line.includes("章内句"))).toBe(false);
  });

  it("要素3 空章（章内无字幕）不渲染章标题，其标题不吞掉其他片段", () => {
    const lines = buildSubtitleSectionLines(
      body([{ from: 0, content: "片头句" }]),
      [{ title: "空章", from: 100, to: 200 }],
      tsOn,
      false
    );

    expect(lines).not.toContain("### 空章 `01:40`");
    expect(lines).toContain("### 其他片段");
    expect(lines.some((line) => line.includes("片头句"))).toBe(true);
  });

  it("要素4 末尾空行裁剪：分桶结果的最后一个元素是内容行而非空串", () => {
    const lines = buildSubtitleSectionLines(
      body([{ from: 10, content: "唯一一句" }]),
      [{ title: "第一章", from: 10, to: 20 }],
      tsOn,
      false
    );

    // 章节段末尾 push 的空行分隔符被裁掉，最后一个是字幕内容行
    expect(lines[lines.length - 1]).not.toBe("");
    expect(lines[lines.length - 1]).toContain("唯一一句");
  });

  it("无章节：退化为整段字幕行列表，不出现任何 ### 标题", () => {
    const lines = buildSubtitleSectionLines(
      body([
        { from: 0, content: "第一句" },
        { from: 5, content: "第二句" }
      ]),
      [],
      tsOn,
      false
    );

    expect(lines).toEqual(["`0:00` 第一句", "`0:05` 第二句"]);
  });

  it("无字幕：返回占位行「（暂无字幕）」", () => {
    expect(buildSubtitleSectionLines([], [{ title: "第一章", from: 0 }], tsOn, false)).toEqual([
      "（暂无字幕）"
    ]);
    expect(buildSubtitleSectionLines(null, null, tsOn, false)).toEqual(["（暂无字幕）"]);
  });

  it("includeTimestampInBody=false：章节标题不带时间戳、行只有文本", () => {
    const lines = buildSubtitleSectionLines(
      body([{ from: 10, content: "纯文本" }]),
      [{ title: "第一章", from: 10, to: 20 }],
      { includeTimestampInBody: false },
      false
    );

    expect(lines).toEqual(["### 第一章", "", "纯文本"]);
  });

  it("withHours=true：章节标题与行内时间戳走 H:MM:SS 不补零口径", () => {
    const lines = buildSubtitleSectionLines(
      body([{ from: 3600, content: "一小时后" }]),
      [{ title: "长章", from: 3600, to: 7200 }],
      tsOn,
      true
    );

    expect(lines).toEqual(["### 长章 `1:00:00`", "", "`1:00:00` 一小时后"]);
  });
});

// ===== buildMarkdown：逐段断言 =====

describe("buildMarkdown", () => {
  const baseSettings = {
    tags: "note, test",
    includeTimestampInBody: true,
    includeHotCommentsInNote: false,
    frontmatterFields: ["title", "url", "bvid", "cid", "author", "upload_date", "subtitle_lang", "created", "tags"],
    fixedFrontmatterProperties: [],
    notePlaceholderSections: []
  };

  const fullMeta = {
    aid: "123",
    title: "视频标题",
    bvid: "BV1abcDEFghi",
    cid: "42",
    author: "UP主",
    uploadDate: "2026-01-02",
    selectedSubtitleLang: "zh-CN",
    description: "这是简介",
    chapters: [
      { title: "第一章", from: 0, to: 10 },
      { title: "第二章", from: 10, to: 20 }
    ],
    hotComments: [
      { uname: "甲", like: 10, message: "说得好" },
      { uname: "乙", like: 5, message: "学到了" }
    ]
  };

  it("完整结构：frontmatter → iframe → 简介 → 章节 → 字幕分段", () => {
    setLocationUrl("https://www.bilibili.com/video/BV1abcDEFghi/?p=2");
    const md = buildMarkdown(
      fullMeta,
      body([
        { from: 0, content: "第一句" },
        { from: 10, content: "第二句" }
      ]),
      baseSettings
    );
    const lines = md.split("\n");

    // frontmatter：--- 包裹 + 启用字段逐行落位（tags 归一为 yaml 数组）
    expect(lines[0]).toBe("---");
    expect(lines).toContain('title: "视频标题"');
    expect(lines).toContain('url: "https://www.bilibili.com/video/BV1abcDEFghi/?p=2"');
    expect(lines).toContain('bvid: "BV1abcDEFghi"');
    expect(lines).toContain('cid: "42"');
    expect(lines).toContain('author: "UP主"');
    expect(lines).toContain('upload_date: "2026-01-02"');
    expect(lines).toContain('subtitle_lang: "zh-CN"');
    expect(lines.some((line) => /^created: "\d{4}-\d{2}-\d{2}"$/.test(line))).toBe(true);
    expect(lines).toContain('tags: ["note", "test"]');
    // 闭合 --- 紧跟最后一个字段行（无自定义属性时即 tags 行）
    expect(lines[lines.indexOf("tags: [") + 1]).toBe("---");

    // iframe：嵌入播放器带 aid/bvid/cid，page 取自 location 的 p 参数
    const iframe = lines.find((line) => line.startsWith("<iframe"));
    expect(iframe).toContain("aid=123&bvid=BV1abcDEFghi&cid=42&page=2&autoplay=0");

    // 简介
    expect(lines).toContain("## 简介");
    expect(lines).toContain("这是简介");

    // 章节：紧凑时间戳（不补零，arch-slim-2/08 拍板 Q1）
    expect(lines).toContain("## 章节");
    expect(lines).toContain("- `0:00` 第一章");
    expect(lines).toContain("- `0:10` 第二章");

    // 字幕：走同一套章节分桶（标题带章首时间戳）
    expect(lines).toContain("## 字幕");
    expect(lines).toContain("### 第一章 `0:00`");
    expect(lines).toContain("`0:00` 第一句");
    expect(lines).toContain("### 第二章 `0:10`");
    expect(lines).toContain("`0:10` 第二句");

    // 顺序约束：frontmatter < iframe < 简介 < 章节 < 字幕
    const indexOf = (needle) => lines.findIndex((line) => line === needle || line.startsWith(needle));
    expect(indexOf("---")).toBeLessThan(indexOf("<iframe"));
    expect(indexOf("<iframe")).toBeLessThan(indexOf("## 简介"));
    expect(indexOf("## 简介")).toBeLessThan(indexOf("## 章节"));
    expect(indexOf("## 章节")).toBeLessThan(indexOf("## 字幕"));
  });

  it("评论节：includeHotCommentsInNote=true 时输出「## 评论」，编号 + 点赞 + 内容", () => {
    const md = buildMarkdown(fullMeta, body([{ from: 0, content: "第一句" }]), {
      ...baseSettings,
      includeHotCommentsInNote: true
    });

    expect(md).toContain("## 评论");
    expect(md).toContain("1. 甲（赞 10）");
    expect(md).toContain("说得好");
    expect(md).toContain("2. 乙（赞 5）");
    expect(md).toContain("学到了");
  });

  it("评论节：includeHotCommentsInNote=false（默认）即使 meta 带热评也不输出", () => {
    const md = buildMarkdown(fullMeta, body([{ from: 0, content: "第一句" }]), baseSettings);
    expect(md).not.toContain("## 评论");
  });

  it("占位节：before_subtitle 位置的段落渲染在「## 字幕」之前，模板变量 {{title}} 解析", () => {
    const md = buildMarkdown(fullMeta, body([{ from: 0, content: "第一句" }]), {
      ...baseSettings,
      notePlaceholderSections: [{ title: "我的总结", position: "before_subtitle", content: "{{title}} 的总结" }]
    });
    const lines = md.split("\n");

    expect(lines).toContain("## 我的总结");
    expect(lines).toContain("视频标题 的总结");
    expect(lines.indexOf("## 我的总结")).toBeLessThan(lines.indexOf("## 字幕"));
  });

  it("占位节：before_intro 渲染在简介前、before_chapters 渲染在章节前", () => {
    const md = buildMarkdown(fullMeta, body([{ from: 0, content: "第一句" }]), {
      ...baseSettings,
      notePlaceholderSections: [
        { title: "导读", position: "before_intro", content: "" },
        { title: "目录", position: "before_chapters", content: "" }
      ]
    });
    const lines = md.split("\n");

    expect(lines.indexOf("## 导读")).toBeLessThan(lines.indexOf("## 简介"));
    expect(lines.indexOf("## 目录")).toBeGreaterThan(lines.indexOf("## 简介"));
    expect(lines.indexOf("## 目录")).toBeLessThan(lines.indexOf("## 章节"));
  });

  it("无字幕：字幕区落「（暂无字幕）」占位，meta 无章节时不渲染章节节", () => {
    const md = buildMarkdown({ ...fullMeta, chapters: [] }, [], baseSettings);
    expect(md).toContain("## 字幕");
    expect(md).toContain("（暂无字幕）");
    expect(md).not.toContain("## 章节");
    expect(md).not.toContain("### 第一章");
  });

  it("frontmatter 字段未启用时不输出对应行，全部未启用且无自定义属性时省略 frontmatter", () => {
    const md = buildMarkdown(fullMeta, body([{ from: 0, content: "第一句" }]), {
      ...baseSettings,
      frontmatterFields: ["author"]
    });
    expect(md).toContain('author: "UP主"');
    expect(md).not.toContain("title: ");

    const mdNoFrontmatter = buildMarkdown(fullMeta, body([{ from: 0, content: "第一句" }]), {
      ...baseSettings,
      frontmatterFields: []
    });
    expect(mdNoFrontmatter.startsWith("---")).toBe(false);
    expect(mdNoFrontmatter.startsWith("<iframe")).toBe(true);
  });
});

// ===== buildTxt / buildSrt / buildSubtitlePreview / shouldShowHoursInNote =====

describe("buildTxt", () => {
  it("includeTimestampInBody 缺省/false：纯文本逐行拼接，空内容行被过滤", () => {
    const items = body([
      { from: 0, content: "第一句" },
      { from: 5, content: "   " },
      { from: 10, content: "第二句" }
    ]);
    expect(buildTxt(items)).toBe("第一句\n第二句");
    expect(buildTxt(items, { includeTimestampInBody: false })).toBe("第一句\n第二句");
  });

  it("includeTimestampInBody=true：紧凑时间戳前缀，时长 < 1 小时不补时位", () => {
    expect(
      buildTxt(body([{ from: 65, content: "一分五秒" }]), { includeTimestampInBody: true })
    ).toBe("1:05 一分五秒");
  });

  it("maxTo >= 3600 时自动切 H:MM:SS 小时口径（shouldShowHoursInSubtitle 看 to 的 max）", () => {
    expect(
      buildTxt(body([{ from: 3600, to: 3605, content: "整点句" }]), { includeTimestampInBody: true })
    ).toBe("1:00:00 整点句");
  });
});

describe("buildSrt", () => {
  it("序号 + 逗号毫秒时间轴 + 文本，条目间空行分隔", () => {
    expect(
      buildSrt(
        body([
          { from: 0, to: 5, content: "第一句" },
          { from: 5.5, to: 8, content: "第二句" }
        ])
      )
    ).toBe(
      [
        "1\n00:00:00,000 --> 00:00:05,000\n第一句",
        "2\n00:00:05,500 --> 00:00:08,000\n第二句"
      ].join("\n\n")
    );
  });

  it("空入参返回空串", () => {
    expect(buildSrt(null)).toBe("");
    expect(buildSrt([])).toBe("");
  });
});

describe("buildSubtitlePreview", () => {
  it("includeTimestampInBody=true：反引号紧凑时间戳前缀，空内容行被过滤", () => {
    expect(
      buildSubtitlePreview(
        body([
          { from: 0, content: "第一句" },
          { from: 5, content: "" },
          { from: 10, content: "第二句" }
        ]),
        { includeTimestampInBody: true }
      )
    ).toBe("`0:00` 第一句\n`0:10` 第二句");
  });

  it("includeTimestampInBody=false：纯文本预览", () => {
    expect(buildSubtitlePreview(body([{ from: 0, content: "第一句" }]), {})).toBe("第一句");
  });

  it("maxTo >= 3600 时切小时口径", () => {
    expect(
      buildSubtitlePreview(body([{ from: 7225, to: 7230, content: "两小时句" }]), { includeTimestampInBody: true })
    ).toBe("`2:00:25` 两小时句");
  });
});

describe("shouldShowHoursInNote：三输入 max 口径", () => {
  it("字幕 maxTo 达标：to=3600 → true；to=3599 → false", () => {
    expect(shouldShowHoursInNote({}, body([{ from: 0, to: 3600 }]))).toBe(true);
    expect(shouldShowHoursInNote({}, body([{ from: 0, to: 3599 }]))).toBe(false);
  });

  it("章节 max(from, to) 参与：无字幕时 chapter.to=3600 → true、chapter.from=3700 → true", () => {
    expect(
      shouldShowHoursInNote({ chapters: [{ title: "长章", from: 3500, to: 3600 }] }, [])
    ).toBe(true);
    expect(
      shouldShowHoursInNote({ chapters: [{ title: "后段", from: 3700, to: 3800 }] }, [])
    ).toBe(true);
    expect(
      shouldShowHoursInNote({ chapters: [{ title: "短章", from: 0, to: 3599 }] }, [])
    ).toBe(false);
  });

  it("meta.videoDuration 参与：无字幕无章节时 duration=7200 → true、3599 → false", () => {
    expect(shouldShowHoursInNote({ videoDuration: 7200 }, [])).toBe(true);
    expect(shouldShowHoursInNote({ videoDuration: 3599 }, [])).toBe(false);
  });

  it("三输入取 max：字幕不达标但章节达标即 true；全空入参 false", () => {
    expect(
      shouldShowHoursInNote(
        { chapters: [{ title: "长章", from: 0, to: 4000 }], videoDuration: 60 },
        body([{ from: 0, to: 30 }])
      )
    ).toBe(true);
    expect(shouldShowHoursInNote(null, null)).toBe(false);
  });
});
