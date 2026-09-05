// 消息协议响应半边扫描（arch-slim-2/02 验收，沿 reader/shell-sequence.test.js
// 的源码文本级扫描先例）：
//  1. extension/ 源码内 `as { ok` 型响应形状断言清零——响应形状改由消息类型经
//     ResponseOf 推断（shared/messaging-protocol.ts 的 ResponseOf 条件映射 +
//     shared/messaging.ts 的泛型 sendRuntimeMessage），消费点不再手猜形状；
//  2. 每条 ContentScriptMessage / BackgroundMessage 消息别名都有并列声明的
//     `XxxResponse` 响应类型；
//  3. entry/background.ts 的 messageHandlerTable 路由表键集与 BackgroundMessage
//     的消息字面量集全等（编译期由 satisfies 穷尽保证，本扫描是同向的运行期
//     冗余防线：漏注册 / 多注册未知名 / 消息与路由漂移都在这里再拦一道）。
//
// 用 .js 落地：扫描要读 node:fs/node:path，tsconfig 未含 node 类型（与
// shell-sequence 扫描同款选择）。tests/ 不在扫描范围。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const EXTENSION_ROOT = join(process.cwd(), "extension");

function listSourceFiles(dir) {
  const result = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      result.push(...listSourceFiles(full));
      continue;
    }
    if (/\.(ts|js)$/.test(entry)) {
      result.push(full);
    }
  }
  return result;
}

const sourceFileMap = new Map(
  listSourceFiles(EXTENSION_ROOT).map((file) => [
    relative(EXTENSION_ROOT, file).split(sep).join("/"),
    readFileSync(file, "utf8")
  ])
);
const read = (file) => {
  const text = sourceFileMap.get(file);
  if (text === undefined) {
    throw new Error(`扫描目标不存在：${file}`);
  }
  return text;
};

const PROTOCOL = "shared/messaging-protocol.ts";
const BACKGROUND = "entry/background.ts";

// 消息别名 → 线上 type 字面量（仅匹配单块声明体内的 type: "..."，响应类型
// 声明体没有 type: 字面量，不会误配）
const MESSAGE_LITERAL_RE = /export type (\w+) = \{[^}]*?type:\s*"([^"]+)"/g;

function parseUnionMembers(protocolText, unionName) {
  const block = protocolText.match(new RegExp(`export type ${unionName} =([\\s\\S]*?);`));
  if (!block) {
    throw new Error(`messaging-protocol.ts 缺少 ${unionName} union`);
  }
  const members = [];
  for (const match of block[1].matchAll(/\|\s*(\w+)/g)) {
    members.push(match[1]);
  }
  if (members.length === 0) {
    throw new Error(`${unionName} union 未解析到成员`);
  }
  return members;
}

const protocolText = read(PROTOCOL);

const messageLiterals = new Map();
for (const match of protocolText.matchAll(MESSAGE_LITERAL_RE)) {
  messageLiterals.set(match[1], match[2]);
}

const contentMembers = parseUnionMembers(protocolText, "ContentScriptMessage");
const backgroundMembers = parseUnionMembers(protocolText, "BackgroundMessage");
const allMembers = [...new Set([...contentMembers, ...backgroundMembers])];

describe("消息协议响应半边（arch-slim-2/02）", () => {
  it("extension/ 源码内 as { ok 型响应断言清零", () => {
    const offenders = [];
    for (const [file, text] of sourceFileMap) {
      // 容忍任意空白形态：as { ok / as{ok / as {ok 均算手猜响应形状
      if (/as\s*\{\s*ok/.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("每条消息别名都有并列声明的 XxxResponse 响应类型", () => {
    const missing = allMembers
      .filter((alias) => !messageLiterals.has(alias))
      .map((alias) => `${alias}（缺 type 字面量声明，扫描器无法定位）`);
    expect(missing).toEqual([]);

    const noResponse = allMembers
      .filter((alias) => {
        const responseAlias = alias.replace(/Message$/, "Response");
        return !new RegExp(`export type ${responseAlias}\\b`).test(protocolText);
      })
      .map((alias) => `${alias} → ${alias.replace(/Message$/, "Response")} 缺失`);
    expect(noResponse).toEqual([]);
  });

  it("ResponseOf 条件映射存在且覆盖消息映射入口", () => {
    expect(protocolText).toContain("export type ResponseOf<M>");
    // 传输层把返回类型接到映射上
    expect(read("shared/messaging.ts")).toMatch(/Promise<ResponseOf<M>>/);
  });

  it("background 路由表键集与 BackgroundMessage 消息字面量集全等", () => {
    const backgroundLiterals = backgroundMembers.map((alias) => {
      const literal = messageLiterals.get(alias);
      if (!literal) {
        throw new Error(`${alias} 未解析到 type 字面量`);
      }
      return literal;
    });

    const tableText = read(BACKGROUND).match(
      /const messageHandlerTable = \{([\s\S]*?)\} satisfies/
    );
    if (!tableText) {
      throw new Error("background.ts 缺少 messageHandlerTable satisfies 穷尽路由表");
    }
    const routeKeys = [...tableText[1].matchAll(/"([a-z][a-z0-9-]*)"\s*:/g)].map((m) => m[1]);

    expect(routeKeys).toHaveLength(backgroundLiterals.length);
    expect([...routeKeys].sort()).toEqual([...backgroundLiterals].sort());
    // 路由表经 satisfies 穷尽后构建 Map（运行时结构不变）
    expect(read(BACKGROUND)).toContain("new Map<BackgroundMessageType, BackgroundHandler>(");
  });
});
