// 测试文件在 Node 环境运行，仅 reader 测试用到 fs/path/process 的最小子集。
// 不引入完整 @types/node，避免把 Node 全局泄漏到扩展源码类型检查面。

declare module "node:fs" {
  export function readFileSync(path: string, options?: { encoding?: string } | string): string;
}

declare module "node:path" {
  export function resolve(...paths: string[]): string;
}

declare const process: {
  cwd(): string;
};
