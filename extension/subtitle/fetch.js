import { sleep } from "../core/shared-defaults.js";
import { getErrorMessage, isRetryableNetworkError } from "../shared/error-helpers.js";
import { logInfo, logWarn } from "../shared/logging.js";
import { contentFetchJson } from "../bilibili/bili-api.js";
import {
  fetchVideoMeta as gatewayFetchVideoMeta,
  fetchSubtitleBundle as gatewayFetchSubtitleBundle
} from "../bili-gateway.js";

export async function retryAsync(task, retries = 1, delayMs = 180) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      const isNetworkError = isRetryableNetworkError(error);
      const isRetryable = error?.retryable === true;
      if (!isNetworkError && !isRetryable) {
        throw error;
      }
      if (attempt >= retries) {
        throw error;
      }
      const backoffDelay = Math.min(delayMs * Math.pow(2, attempt - 1), 5000);
      logInfo(`[BOC] retrying after ${backoffDelay}ms, attempt ${attempt + 1}/${retries}`, {
        error: getErrorMessage(error),
        code: error.code
      });
      await sleep(backoffDelay);
    }
  }
  throw lastError || new Error("Unknown retry error");
}

export async function fetchVideoMeta(bvid) {
  logInfo("[BOC] fetch video meta", {
    url: `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
    bvid
  });
  return gatewayFetchVideoMeta(contentFetchJson, bvid);
}

export async function fetchSubtitleBundle(bvid, cid, aid = "") {
  logInfo("[BOC] fetch subtitles list", { bvid, cid, aid });
  try {
    return await gatewayFetchSubtitleBundle(contentFetchJson, { bvid, cid, aid });
  } catch (error) {
    logWarn("[BOC] subtitles API request failed", {
      bvid,
      cid,
      aid,
      message: getErrorMessage(error)
    });
    throw error;
  }
}
