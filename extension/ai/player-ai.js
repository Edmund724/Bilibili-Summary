import { setMessage } from "../ui/ui-message.js";
import {
  isReaderMode
} from "../bilibili/url-utils.js";
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
import { isReaderViewOpen } from "../reader/index.js";

const PLAYER_AI_ICON_VARIANT = "badge";

let playerAiQuickActionRetryCount = 0;

export function resetPlayerAiQuickActionRetryCount() {
  playerAiQuickActionRetryCount = 0;
}

export {
  PLAYER_AI_ICON_VARIANT,
  isReaderMode,
  sendRuntimeMessage,
  getSettings,
  getErrorMessage,
  setMessage,
  startPlayerAiQuickActionObserver,
  bindPlayerAiQuickActionLayoutEvents,
  schedulePlayerAiQuickActionSync,
  schedulePlayerAiQuickActionRetry,
  syncPlayerAiQuickActionButton,
  removePlayerAiQuickActionButton,
  bindPlayerAiQuickActionCursorSync,
  hasPlayerSubtitleControl,
  findPlayerSubtitleControlNode,
  isPlayerSubtitleControlNode,
  findPlayerAiQuickActionHost,
  buildPlayerAiQuickActionIconSvg,
  syncPlayerAiQuickActionVisuals,
  handlePlayerAiQuickActionClick,
  isVisibleReaderControl
};

const PLAYER_CONTAINER_SELECTOR = ".bpx-player-container, #bilibili-player";

function startPlayerAiQuickActionObserver() {
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

function bindPlayerAiQuickActionLayoutEvents() {
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

function schedulePlayerAiQuickActionSync(delayMs = 120) {
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

function removePlayerAiQuickActionButton() {
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

function buildPlayerAiQuickActionIconSvg() {
  const variants = {
    badge: `
      <svg viewBox="0 0 132 132" focusable="false" aria-hidden="true" data-ai-icon="badge">
        <path stroke-width="8.25" d="M22 90.7494C22 99.8618 29.3873 107.249 38.5 107.249C38.5 114.843 44.6561 120.999 52.25 120.999C59.8438 120.999 66 114.843 66 107.249C66 114.843 72.1562 120.999 79.75 120.999C87.3438 120.999 93.5 114.843 93.5 107.249C102.613 107.249 110 99.8613 110 90.7489C110 87.621 109.13 84.6967 107.618 82.2046C115.24 80.7466 121 74.0454 121 65.9989C121 57.9518 115.24 51.2507 107.618 49.7929C109.13 47.3006 110 44.3763 110 41.2487C110 32.1359 102.613 24.7487 93.5 24.7487C93.5 17.1547 87.3438 10.9987 79.75 10.9987C72.1562 10.9987 66 17.1552 66 24.7492C66 17.1552 59.8438 10.9992 52.25 10.9992C44.6561 10.9992 38.5 17.1552 38.5 24.7492C29.3873 24.7492 22 32.1365 22 41.2492C22 44.3768 22.8702 47.3012 24.3817 49.7934C16.76 51.2512 11 57.9524 11 65.9994C11 74.0459 16.76 80.7471 24.3817 82.2052C22.8702 84.6972 22 87.6216 22 90.7494Z"></path>
        <path stroke-width="8.25" d="M41.25 79.7494L51.3804 49.3582C51.8997 47.8002 53.3577 46.7493 55 46.7493C56.6423 46.7493 58.1004 47.8002 58.6196 49.3582L68.75 79.7494M85.25 46.7493V79.7494M46.75 68.7494H63.25"></path>
      </svg>
    `,
    sparkles: `
      <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true" data-ai-icon="sparkles">
        <path stroke-width="1.8" d="M12 3.6l1.84 4.96 4.96 1.84-4.96 1.84L12 17.2l-1.84-4.96L5.2 10.4l4.96-1.84L12 3.6z"></path>
        <path stroke-width="1.8" d="M18.2 3.8l.64 1.72 1.72.64-1.72.64-.64 1.72-.64-1.72-1.72-.64 1.72-.64.64-1.72z"></path>
        <path stroke-width="1.8" d="M18 14.2l.48 1.28 1.28.48-1.28.48-.48 1.28-.48-1.28-1.28-.48 1.28-.48.48-1.28z"></path>
      </svg>
    `,
    nodes: `
      <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true" data-ai-icon="nodes">
        <circle stroke-width="1.8" cx="7" cy="8" r="2.1"></circle>
        <circle stroke-width="1.8" cx="17" cy="7" r="2.1"></circle>
        <circle stroke-width="1.8" cx="12" cy="16.8" r="2.1"></circle>
        <path stroke-width="1.8" d="M8.8 8.7l2.4 5.2"></path>
        <path stroke-width="1.8" d="M15.2 7.8l-2.2 5.8"></path>
        <path stroke-width="1.8" d="M8.9 8.1h5.9"></path>
      </svg>
    `,
    chip: `
      <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true" data-ai-icon="chip">
        <rect stroke-width="1.8" x="7.2" y="7.2" width="9.6" height="9.6" rx="2.1"></rect>
        <path stroke-width="1.8" d="M10 10h4"></path>
        <path stroke-width="1.8" d="M10 12h4"></path>
        <path stroke-width="1.8" d="M10 14h2.8"></path>
        <path stroke-width="1.8" d="M9 4.8v2"></path>
        <path stroke-width="1.8" d="M12 4.8v2"></path>
        <path stroke-width="1.8" d="M15 4.8v2"></path>
        <path stroke-width="1.8" d="M9 17.2v2"></path>
        <path stroke-width="1.8" d="M12 17.2v2"></path>
        <path stroke-width="1.8" d="M15 17.2v2"></path>
        <path stroke-width="1.8" d="M4.8 9h2"></path>
        <path stroke-width="1.8" d="M4.8 12h2"></path>
        <path stroke-width="1.8" d="M4.8 15h2"></path>
        <path stroke-width="1.8" d="M17.2 9h2"></path>
        <path stroke-width="1.8" d="M17.2 12h2"></path>
        <path stroke-width="1.8" d="M17.2 15h2"></path>
      </svg>
    `
  };
  return variants[PLAYER_AI_ICON_VARIANT] || variants.badge;
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

function isVisibleReaderControl(node) {
  if (!node || typeof node.getBoundingClientRect !== "function") {
    return false;
  }
  const rect = node.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }
  const style = window.getComputedStyle(node);
  return style.display !== "none" && style.visibility !== "hidden" && style.pointerEvents !== "none";
}
