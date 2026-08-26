import { setMessage } from "../ui/ui-renderer.js";
import { buildPlayerAiQuickActionIconSvg } from "../ui/icons.js";
import {
  isReaderMode
} from "../bilibili/video-id-shared.js";
import {
  sendRuntimeMessage,
  getSettings
} from "../core/runtime.js";
import {
  getErrorMessage
} from "../shared/error-helpers.js";
import {
  getRuntimeVideoElement
} from "../bilibili/video-probe.js";
import { state, playerAiState } from "../core/state.js";
import { isVisibleReaderControl } from "../shared/dom-utils.js";
import { isReaderViewOpen } from "../reader/index.js";

let playerAiQuickActionRetryCount = 0;

export function resetPlayerAiQuickActionRetryCount() {
  playerAiQuickActionRetryCount = 0;
}

const PLAYER_CONTAINER_SELECTOR = ".bpx-player-container, #bilibili-player";

export function startPlayerAiQuickActionObserver() {
  if (state.playerAi.playerAiQuickActionObserver || !document.body) {
    return;
  }

  const sync = () => {
    schedulePlayerAiQuickActionSync();
  };
  const observer = new MutationObserver(sync);

  // 优先观察播放器容器；容器不存在时退回观察 body 的 childList（不带
  // subtree/attributes，仅用于发现播放器挂载）。发现播放器后断开 body
  // 观察并切换到容器，避免对整个页面 DOM 变化做回调。
  const playerContainer = document.querySelector(PLAYER_CONTAINER_SELECTOR);
  if (playerContainer) {
    observer.observe(playerContainer, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class"]
    });
    playerAiState.setObserver(observer);
    return;
  }

  const bodyObserver = new MutationObserver(() => {
    const nextPlayerContainer = document.querySelector(PLAYER_CONTAINER_SELECTOR);
    if (!nextPlayerContainer) {
      return;
    }
    bodyObserver.disconnect();
    observer.observe(nextPlayerContainer, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class"]
    });
    playerAiState.setObserver(observer);
    sync();
  });
  bodyObserver.observe(document.body, { childList: true });
  playerAiState.setObserver(bodyObserver);
}

export function bindPlayerAiQuickActionLayoutEvents() {
  if (state.playerAi.playerAiQuickActionLayoutBound) {
    return;
  }
  const schedule = () => schedulePlayerAiQuickActionSync(80);
  window.addEventListener("resize", schedule, { passive: true });
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("pageshow", schedule, { passive: true });
  document.addEventListener("fullscreenchange", schedule);
  document.addEventListener("webkitfullscreenchange", schedule);
  window.visualViewport?.addEventListener?.("resize", schedule, { passive: true });
  playerAiState.setLayoutBound(true);
}

export function schedulePlayerAiQuickActionSync(delayMs = 120) {
  if (state.playerAi.playerAiQuickActionSyncTimer) {
    window.clearTimeout(state.playerAi.playerAiQuickActionSyncTimer);
  }
  playerAiState.setSyncTimer(window.setTimeout(() => {
    playerAiState.setSyncTimer(0);
    syncPlayerAiQuickActionButton();
  }, delayMs));
}

function schedulePlayerAiQuickActionRetry() {
  const delay = Math.min(260 * (playerAiQuickActionRetryCount + 1), 2500);
  playerAiQuickActionRetryCount += 1;
  schedulePlayerAiQuickActionSync(delay);
}

function syncPlayerAiQuickActionButton() {
  const existing = document.getElementById("boc-player-ai-quick-action");
  const existingWrap = existing?.closest(".boc-player-ai-wrap");
  if (!state.settings?.enablePlayerAiQuickAction || isReaderViewOpen() || isReaderMode()) {
    removePlayerAiQuickActionButton();
    return;
  }

  if (!hasPlayerSubtitleControl()) {
    removePlayerAiQuickActionButton();
    schedulePlayerAiQuickActionRetry();
    return;
  }

  const playerHost = findPlayerAiQuickActionHost();
  if (!playerHost) {
    existingWrap?.remove();
    existing?.remove();
    schedulePlayerAiQuickActionRetry();
    return;
  }

  let button = existing;
  let wrap = existingWrap instanceof HTMLElement ? existingWrap : null;
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "boc-player-ai-wrap";
    wrap.setAttribute("data-boc-extension-node", "ai-quick-action");
  }
  if (!button) {
    button = document.createElement("button");
    button.id = "boc-player-ai-quick-action";
    button.type = "button";
    button.className = "boc-player-ai-quick-action";
    button.title = "用 AI 分析这期视频";
    button.setAttribute("aria-label", "用 AI 分析这期视频");
    button.innerHTML = buildPlayerAiQuickActionIconSvg();
    button.addEventListener("click", handlePlayerAiQuickActionClick, true);
  }

  if (button.parentElement !== wrap) {
    wrap.replaceChildren(button);
  }
  if (wrap.parentElement !== playerHost) {
    playerHost.appendChild(wrap);
  }
  bindPlayerAiQuickActionCursorSync(wrap);
  syncPlayerAiQuickActionVisuals(button);
  playerAiQuickActionRetryCount = 0;
}

export function removePlayerAiQuickActionButton() {
  if (state.playerAi.playerAiQuickActionRevealTimer) {
    window.clearTimeout(state.playerAi.playerAiQuickActionRevealTimer);
    playerAiState.setRevealTimer(0);
  }
  if (state.playerAi.playerAiQuickActionHideTimer) {
    window.clearTimeout(state.playerAi.playerAiQuickActionHideTimer);
    playerAiState.setHideTimer(0);
  }
  if (state.playerAi.playerAiQuickActionCursorHideTimer) {
    window.clearTimeout(state.playerAi.playerAiQuickActionCursorHideTimer);
    playerAiState.setCursorHideTimer(0);
  }
  document.getElementById("boc-player-ai-quick-action")?.closest(".boc-player-ai-wrap")?.remove();
}

function bindPlayerAiQuickActionCursorSync(wrap) {
  if (!(wrap instanceof HTMLElement)) {
    return;
  }
  const host = wrap.parentElement instanceof HTMLElement ? wrap.parentElement : null;
  if (!host || wrap.__bocPlayerAiCursorHost === host) {
    return;
  }
  const hideForIdle = () => {
    playerAiState.setCursorHideTimer(0);
    wrap.classList.remove("is-active");
  };
  const showForCursorActivity = () => {
    if (!wrap.isConnected || isReaderViewOpen() || isReaderMode()) {
      wrap.classList.remove("is-active");
      return;
    }
    wrap.classList.add("is-active");
    if (state.playerAi.playerAiQuickActionCursorHideTimer) {
      window.clearTimeout(state.playerAi.playerAiQuickActionCursorHideTimer);
    }
    playerAiState.setCursorHideTimer(window.setTimeout(hideForIdle, 1900));
  };
  const hideImmediately = () => {
    if (state.playerAi.playerAiQuickActionCursorHideTimer) {
      window.clearTimeout(state.playerAi.playerAiQuickActionCursorHideTimer);
      playerAiState.setCursorHideTimer(0);
    }
    wrap.classList.remove("is-active");
  };
  host.addEventListener("mousemove", showForCursorActivity, { passive: true });
  host.addEventListener("mouseenter", showForCursorActivity, { passive: true });
  host.addEventListener("mouseleave", hideImmediately, { passive: true });
  host.addEventListener("pointermove", showForCursorActivity, { passive: true });
  wrap.__bocPlayerAiCursorHost = host;
}

function hasPlayerSubtitleControl() {
  return Boolean(findPlayerSubtitleControlNode());
}

function findPlayerSubtitleControlNode() {
  const controlRoots = Array.from(
    document.querySelectorAll(
      "#bilibili-player .bpx-player-control-wrap, #playerWrap .bpx-player-control-wrap, .bpx-player-container .bpx-player-control-wrap, #bilibili-player, #playerWrap, .bpx-player-container, .player-wrap"
    )
  );

  for (const root of controlRoots) {
    const candidates = Array.from(
      root.querySelectorAll(
        "[aria-label*='字幕'], [title*='字幕'], [data-text*='字幕'], [class*='subtitle'], [class*='caption'], button, [role='button']"
      )
    );
    const matched = candidates.find((node) => isPlayerSubtitleControlNode(node));
    if (matched) {
      return matched;
    }
  }

  return null;
}

function isPlayerSubtitleControlNode(node) {
  if (!(node instanceof Element)) {
    return false;
  }
  const text = [
    node.getAttribute("aria-label"),
    node.getAttribute("title"),
    node.getAttribute("data-text"),
    node.textContent,
    typeof node.className === "string" ? node.className : ""
  ]
    .filter((item) => typeof item === "string" && item.trim())
    .join(" ");
  return /字幕|subtitle/i.test(text);
}

function findPlayerAiQuickActionHost() {
  const candidates = [
    document.querySelector(".bpx-player-container"),
    document.querySelector(".bpx-player-video-area"),
    document.getElementById("bilibili-player"),
    document.getElementById("playerWrap"),
    document.querySelector(".player-wrap")
  ];
  const direct = candidates.find((node) => node instanceof HTMLElement && isVisibleReaderControl(node)) || null;
  if (direct) {
    return direct;
  }

  const video = getRuntimeVideoElement();
  if (!video) {
    return null;
  }

  const host =
    video.closest(".bpx-player-container") ||
    video.closest(".bpx-player-video-area") ||
    video.closest("#bilibili-player") ||
    video.closest("#playerWrap") ||
    video.closest(".player-wrap") ||
    video.parentElement;
  if (host instanceof HTMLElement && isVisibleReaderControl(host)) {
    return host;
  }

  return null;
}

function syncPlayerAiQuickActionVisuals(button) {
  if (!(button instanceof HTMLElement)) {
    return;
  }
  const wrap = button.parentElement instanceof HTMLElement ? button.parentElement : null;
  const hitSize = 36;
  const iconSize = 24;
  const baseColor = "#f6f7f8";
  [wrap, button].filter(Boolean).forEach((node) => {
    node.style.setProperty("--boc-player-ai-action-hit-size", `${hitSize}px`);
    node.style.setProperty("--boc-player-ai-action-color", baseColor);
    node.style.setProperty("--boc-player-ai-action-hover-color", baseColor);
  });
  button.style.setProperty("--boc-player-ai-action-icon-size", `${iconSize}px`);
}

async function handlePlayerAiQuickActionClick(event) {
  event.preventDefault();
  event.stopPropagation();
  if (
    state.playerAi.playerAiQuickActionSubmitting ||
    isReaderViewOpen() ||
    isReaderMode() ||
    Date.now() < state.playerAi.playerAiQuickActionSuppressedUntil
  ) {
    return;
  }

  playerAiState.setSubmitting(true);
  const button = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null;
  if (button) {
    button.disabled = true;
  }

  try {
    state.setSettings(await getSettings());
    if (!state.settings?.enablePlayerAiQuickAction) {
      throw new Error("AI 按钮未开启");
    }
    const resp = await sendRuntimeMessage({ type: "player-ai-quick-action" });
    if (!resp?.ok) {
      throw new Error(resp?.error || "打开 AI 侧边栏失败");
    }
    setMessage("已打开 AI 侧边栏并发送快捷提示词。");
  } catch (error) {
    setMessage(`AI 快捷操作失败：${getErrorMessage(error)}`);
  } finally {
    playerAiState.setSubmitting(false);
    if (button) {
      button.disabled = false;
    }
  }
}
