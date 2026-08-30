// 「分段并发」模块（08 票）：以有上界并发池跑逐段小结 worker。
// 并发上限 DEFAULT_MAP_CONCURRENCY=3（规格「限并发 2~3」）；worker(item, index) 与
// onItemDone(result, index) 的 index 恒为该段在 items 中的原始 0-based 下标，
// 最终 results 也按原始下标排布——并发完成顺序可乱，但写回位置不乱。
// 失败按 client.js 的重试语义处理：非 abort 错误重试至多 MAX_MAP_RETRIES 次；
// 带 aborted 标记的错误不重试、整体 rethrow，供上层 Map-Reduce 走中止收束；
// 带 overflow 标记的错误同样不重试——同一素材重发必然再溢出，重试纯属浪费，
// rethrow 交上层 Map-Reduce 做一次「放宽预算」重跑（编排层的兜底策略）。
// signal 中止时不再启动新项，在飞项照常收尾后返回已完成的 results（部分结果）。

// 并发上界：最多同时 3 个分段小结请求在飞。
export const DEFAULT_MAP_CONCURRENCY = 3;
// 单段小结失败重试次数（对齐 ai/completion.js 流式重试默认 2：1 次初始 + 2 次重试，共至多 3 次尝试）。
export const MAX_MAP_RETRIES = 2;

/**
 * 以受限并发执行 map worker，产出按原始下标排布的结果数组。
 * worker(item, index) → Promise<result>；每完成一项调用 onItemDone(result, index)。
 * signal 中止时停止启动后续项；带 aborted / overflow 标记的错误立即 rethrow（不重试）。
 */
export async function runMapBounded({ items, worker, concurrency = DEFAULT_MAP_CONCURRENCY, signal, onItemDone }) {
  const list = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Math.floor(Number(concurrency) || 1));
  const results = new Array(list.length);
  const queue = list.map((_, index) => index);
  let inFlight = 0;
  let finished = false;

  return await new Promise((resolve, reject) => {
    // 整体落定：错误（aborted 标记或重试耗尽）reject，否则 resolve 已完成的 results。
    const settle = (error) => {
      if (finished) return;
      finished = true;
      if (error) reject(error);
      else resolve(results);
    };

    // 补位拉起队列下一项；中止后不再启动新项。
    const pump = () => {
      while (!finished && !signal?.aborted && inFlight < limit && queue.length > 0) {
        const index = queue.shift();
        inFlight += 1;
        runItem(index);
      }
      // 队列排空或中止收尾（在飞项归零）即可结算。
      if (!finished && (signal?.aborted || queue.length === 0) && inFlight === 0) {
        settle(null);
      }
    };

    const runItem = async (index) => {
      let lastError = null;
      let result;
      for (let attempt = 0; attempt <= MAX_MAP_RETRIES; attempt++) {
        try {
          result = await worker(list[index], index);
          break;
        } catch (e) {
          if (e?.aborted) {
            // 中止标记错误：不重试，整体 rethrow（上层 Map-Reduce 走 abort 收束）。
            inFlight -= 1;
            settle(e);
            return;
          }
          if (e?.overflow) {
            // 溢出标记错误：不重试（同素材重发必然再溢出），整体 rethrow
            // 供上层 Map-Reduce 做一次放宽预算重跑。
            inFlight -= 1;
            settle(e);
            return;
          }
          lastError = e;
          // 重试耗尽或已中止：不再重试，rethrow 最后错误。
          if (attempt >= MAX_MAP_RETRIES || signal?.aborted) {
            inFlight -= 1;
            settle(lastError);
            return;
          }
          // 否则进入下一次重试
        }
      }
      results[index] = result;
      try {
        if (!finished) onItemDone?.(result, index);
      } catch (e) {
        inFlight -= 1;
        settle(e);
        return;
      }
      inFlight -= 1;
      pump();
    };

    pump();
  });
}
