// digest-host 右栏定位器测试。
//
// 覆盖：锚点优先级命中与变量写入（贴栏占「锚点左缘 → 视口右界」整条右侧，
// 下限 380px；纵向钳进一屏）、隐藏副本跳过、播放器贴右缘降级、浮层降级
// （属性而非变量）、窄窗浮层、800ms 自查重锚、close 拆除与变量清除。
//（digest-only-ui：面板宽度档机制退役，贴栏宽度下限定死 380px。）
//
// 注意：setup.js 给 Element.prototype.getBoundingClientRect 打了「恒返回
// 800x450」的默认补丁——不覆盖它会让锚点判定/降级分支全部走不到，测试假绿。
// 本文件所有涉及 rect 判定的元素都在用例内显式 stub。jsdom 下
// documentElement.clientWidth 恒 0，视口右界回落 innerWidth（1920）；
// innerHeight 用 jsdom 默认 768。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState, setLocationUrl } from "../setup.js";
import { READER_MODE_URL } from "../setup.js";

type DigestHost = typeof import("../../extension/reader/digest-host.js");

let digestHost: DigestHost;

// 右栏锚点六个选择器对应的可命中节点，按需在用例里往 body 挂。
const ANCHOR_SELECTORS = [
  ".right-container-inner",
  ".right-container",
  ".playlist-container--right",
  "#reco_list",
  "#viewbox_report",
  ".up-info-container"
];

function makeRect(left: number, top: number, width: number, height: number) {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({})
  };
}

// 给指定选择器创建节点并 stub rect；挂在 body 下（digest-host 只读不插）。
function mountAnchor(selector: string, rect: ReturnType<typeof makeRect>): HTMLElement {
  const node = document.createElement("div");
  if (selector.startsWith("#")) {
    node.id = selector.slice(1);
  } else {
    node.className = selector.slice(1);
  }
  node.getBoundingClientRect = () => rect as DOMRect;
  document.body.appendChild(node);
  return node;
}

// 搭最小播放器链（video → 宿主链），让 video-probe 的 findReaderPlayerHost 命中。
function mountPlayerChain(playerRect: ReturnType<typeof makeRect>) {
  const host = document.createElement("div");
  host.className = "bpx-player-container";
  host.getBoundingClientRect = () => playerRect as DOMRect;
  const video = document.createElement("video");
  host.appendChild(video);
  document.body.appendChild(host);
  return { host, video };
}

function readingView(): HTMLElement {
  const node = document.getElementById("boc-reading-view");
  if (!node) {
    throw new Error("missing #boc-reading-view");
  }
  return node as HTMLElement;
}

function vars(el: HTMLElement): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ["left", "top", "width", "height"]) {
    result[name] = el.style.getPropertyValue(`--boc-digest-${name}`);
  }
  return result;
}

async function loadModules() {
  setLocationUrl(READER_MODE_URL);
  digestHost = await import("../../extension/reader/digest-host.js");
}

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
  window.innerWidth = 1920;
  // 定位写组的目标元素（真实页面由 ui-renderer 挂在 body 下）。
  const view = document.createElement("div");
  view.id = "boc-reading-view";
  document.body.appendChild(view);
  // 锚点不在 beforeEach 统一挂载：querySelector 按 DOM 顺序取首个命中，
  // 统一挂默认锚点会抢走各用例自建锚点的优先级，各用例按需显式 mount。
});

// fake timers 下 rAF 也被 mock，不会自动触发；换成同步执行保证
// scheduleDigestLayout 的合帧回调在断言前跑完。
function runRafSynchronously() {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0);
    return 0;
  });
}

afterEach(async () => {
  digestHost?.closeDigestHost();
  document.body.innerHTML = "";
  window.innerWidth = 1024;
  vi.restoreAllMocks();
});

describe("digest-host 锚点命中", () => {
  it.each([
    [".right-container-inner", "新版播放页"],
    [".right-container", "外层兜底"],
    [".playlist-container--right", "合集/列表态"],
    ["#reco_list", "旧版播放页"],
    ["#viewbox_report", "旧版无推荐列表"],
    [".up-info-container", "旧版无推荐列表兜底"]
  ])("优先级锚点 %s（%s）命中时写入四个变量", async (selector) => {
    await loadModules();
    const rect = makeRect(1520, 80, 360, 2000);
    mountAnchor(selector, rect);

    digestHost.openDigestHost();

    const el = readingView();
    expect(el.getAttribute("data-boc-digest-float")).toBe(null);
    // 贴栏占「锚点左缘 1520 → 视口右界 1920」：宽 400；纵向钳进一屏
    //（top 80，height = 768 - 80，而非锚点的 2000）。
    expect(vars(el)).toEqual({
      left: "1520px",
      top: "80px",
      width: "400px",
      height: "688px"
    });
  });

  it("优先级：高优先锚点存在时跳过低优先锚点", async () => {
    await loadModules();
    mountAnchor(".right-container-inner", makeRect(1520, 80, 360, 2000));
    mountAnchor("#reco_list", makeRect(1500, 100, 340, 1500));

    digestHost.openDigestHost();

    // 高优先锚点左缘 1520 → 视口右界 1920：宽 400（低优先的 1500 未生效）。
    expect(vars(readingView()).width).toBe("400px");
  });

  it("可填宽度不足下限 380：左缘左移补足", async () => {
    await loadModules();
    // 锚点左缘 1640：可填宽 1920-1640=280 < 380 → 左缘左移到 1920-380=1540，
    // 宽度恒为 380。
    mountAnchor(".right-container-inner", makeRect(1640, 80, 280, 2000));

    digestHost.openDigestHost();
    expect(vars(readingView())).toEqual({
      left: "1540px",
      top: "80px",
      width: "380px",
      height: "688px"
    });
  });

  it("视口右界用 clientWidth（不含经典滚动条）：页面滚动条带不被覆盖", async () => {
    await loadModules();
    // innerWidth 1920 含 20px 经典滚动条 → clientWidth 1900。
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1900);
    mountAnchor(".right-container-inner", makeRect(1520, 80, 360, 2000));

    digestHost.openDigestHost();
    expect(vars(readingView())).toEqual({
      left: "1520px",
      top: "80px",
      width: "380px",
      height: "688px"
    });
  });

  it("锚点滚出视口顶（top 为负）：面板顶钳到 0、高度撑满一屏", async () => {
    await loadModules();
    const anchor = mountAnchor(".right-container-inner", makeRect(1520, -300, 360, 2000));

    digestHost.openDigestHost();
    expect(vars(readingView())).toEqual({
      left: "1520px",
      top: "0px",
      width: "400px",
      height: "768px"
    });
    expect(anchor).toBeTruthy();
  });

  it("锚点 rect.right 超出视口的候选被跳过，落到下一个有效候选", async () => {
    await loadModules();
    // 1920 视口，第一个锚点右缘 2000 出界；第二个有效。
    const outOfViewport = mountAnchor(".right-container-inner", makeRect(1640, 80, 360, 2000));
    document.body.appendChild(outOfViewport);
    mountAnchor(".right-container", makeRect(1520, 80, 360, 2000));

    digestHost.openDigestHost();

    expect(vars(readingView()).top).toBe("80px");
  });
});

describe("digest-host 隐藏副本跳过", () => {
  it("width 0 的隐藏高优先锚点被跳过，落到次优先有效锚点", async () => {
    await loadModules();
    const hidden = mountAnchor(".right-container-inner", makeRect(0, 0, 0, 0));
    document.body.appendChild(hidden);
    mountAnchor(".right-container", makeRect(1520, 80, 360, 2000));

    digestHost.openDigestHost();

    expect(vars(readingView()).top).toBe("80px");
  });

  it("全部锚点均为隐藏副本（width 0）→ 降级贴播放器右缘", async () => {
    await loadModules();
    const hidden = [];
    for (const selector of ANCHOR_SELECTORS) {
      hidden.push(mountAnchor(selector, makeRect(0, 0, 0, 0)));
    }
    // 高优先隐藏锚点插在 body 尾部，确保排序不是按 DOM 顺序撞对结果。
    hidden.forEach((node) => document.body.appendChild(node));
    mountPlayerChain(makeRect(0, 80, 1000, 560));

    digestHost.openDigestHost();

    // left = 1000 + 12 = 1012，宽 = 1920 - 1012 = 908（占满到视口右界），
    // 纵向钳进一屏（top 80，height = 768 - 80）。
    expect(vars(readingView())).toEqual({
      left: "1012px",
      top: "80px",
      width: "908px",
      height: "688px"
    });
  });
});

describe("digest-host 降级链", () => {
  it("锚点全落空但有播放器：面板占「播放器右缘 + 12 → 视口右界」，纵向钳进一屏", async () => {
    await loadModules();
    mountPlayerChain(makeRect(0, 80, 1000, 560));

    digestHost.openDigestHost();

    expect(vars(readingView())).toEqual({
      left: "1012px",
      top: "80px",
      width: "908px",
      height: "688px"
    });
  });

  it("播放器右缘太靠右挤不出 300 宽 → 继续降级为浮层", async () => {
    await loadModules();
    // 播放器右缘 1700：left 1712，可用 1920-1712=208 < 300 → 浮层。
    mountPlayerChain(makeRect(0, 80, 1700, 560));

    digestHost.openDigestHost();

    const el = readingView();
    expect(el.getAttribute("data-boc-digest-float")).toBe("1");
    expect(vars(el)).toEqual({ left: "", top: "", width: "", height: "" });
  });

  it("锚点与播放器都没有：浮层属性，不写变量", async () => {
    await loadModules();

    digestHost.openDigestHost();

    const el = readingView();
    expect(el.getAttribute("data-boc-digest-float")).toBe("1");
    expect(vars(el)).toEqual({ left: "", top: "", width: "", height: "" });
  });

  it("innerWidth < 1000：直接浮层形态（即使锚点有效）", async () => {
    await loadModules();
    window.innerWidth = 900;
    mountAnchor(".right-container-inner", makeRect(520, 80, 360, 2000));

    digestHost.openDigestHost();

    const el = readingView();
    expect(el.getAttribute("data-boc-digest-float")).toBe("1");
    expect(vars(el)).toEqual({ left: "", top: "", width: "", height: "" });
  });

  it("浮层 → 贴栏双向切换：resize 到宽视口后清浮层属性并写变量", async () => {
    await loadModules();
    window.innerWidth = 900;
    const anchor = mountAnchor(".right-container-inner", makeRect(520, 80, 360, 2000));

    digestHost.openDigestHost();
    expect(readingView().getAttribute("data-boc-digest-float")).toBe("1");

    window.innerWidth = 1920;
    // 锚点 rect 不随 innerWidth 自动变，改成宽视口下的正确值。
    anchor.getBoundingClientRect = () => makeRect(1520, 80, 360, 2000) as DOMRect;
    runRafSynchronously();
    window.dispatchEvent(new Event("resize"));
    vi.restoreAllMocks();

    const el = readingView();
    expect(el.getAttribute("data-boc-digest-float")).toBe(null);
    // 贴栏恢复：占锚点左缘 1520 → 视口右界 1920，宽 400。
    expect(vars(el).width).toBe("400px");
  });
});

describe("digest-host 重算时机", () => {
  it("resize/scroll 触发 rAF 合帧重算，rect 变化后变量更新", async () => {
    await loadModules();
    const anchor = mountAnchor(".right-container-inner", makeRect(1520, 80, 360, 2000));
    digestHost.openDigestHost();

    const rafSpy = vi.spyOn(window, "requestAnimationFrame");
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("scroll"));
    // 合帧：两次事件只排一帧。
    expect(rafSpy).toHaveBeenCalledTimes(1);

    // 滚动后锚点 rect 变化（fixed 定位需跟滚）：挂起帧执行时读的是当下
    // rect，等它在 jsdom 的 rAF 定时器上落地后变量更新为新 top。
    anchor.getBoundingClientRect = () => makeRect(1520, 20, 360, 2000) as DOMRect;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(vars(readingView()).top).toBe("20px");
    // 合帧期内未再排新帧。
    expect(rafSpy).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("800ms 自查：锚点节点被换掉后重锚到新节点", async () => {
    vi.useFakeTimers();
    await loadModules();
    const old = mountAnchor(".right-container-inner", makeRect(1520, 80, 360, 2000));
    digestHost.openDigestHost();
    expect(vars(readingView()).width).toBe("400px");

    // SPA 换页：旧节点 rect 塌掉（从文档里摘掉后 stub 仍在但新节点顶上）。
    old.getBoundingClientRect = () => makeRect(0, 0, 0, 0) as DOMRect;
    mountAnchor(".right-container", makeRect(1500, 100, 360, 1800));

    // 自查换锚后经 rAF 应用；rAF 换成同步跑，保证断言前落地。
    runRafSynchronously();
    vi.advanceTimersByTime(801);

    expect(vars(readingView()).top).toBe("100px");
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("open 幂等：重复 open 不叠加监听/定时器，rect 仍正确", async () => {
    vi.useFakeTimers();
    await loadModules();
    mountAnchor(".right-container-inner", makeRect(1520, 80, 360, 2000));
    digestHost.openDigestHost();
    digestHost.openDigestHost();

    const setIntervalSpy = vi.spyOn(window, "setInterval");
    digestHost.openDigestHost();
    expect(setIntervalSpy).not.toHaveBeenCalled();

    expect(vars(readingView()).width).toBe("400px");
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
});

describe("digest-host close", () => {
  it("close 后清除四个变量与浮层属性，自查定时器停摆", async () => {
    vi.useFakeTimers();
    await loadModules();
    mountAnchor(".right-container-inner", makeRect(1520, 80, 360, 2000));
    digestHost.openDigestHost();
    expect(vars(readingView()).width).toBe("400px");

    digestHost.closeDigestHost();

    const el = readingView();
    expect(vars(el)).toEqual({ left: "", top: "", width: "", height: "" });
    expect(el.getAttribute("data-boc-digest-float")).toBe(null);

    // 定时器停摆：close 后推进时间不再触发重算（变量保持已清除态）。
    mountAnchor(".right-container", makeRect(1500, 100, 360, 1800));
    runRafSynchronously();
    vi.advanceTimersByTime(2000);
    expect(vars(el).width).toBe("");
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("close → 再 open 正常工作", async () => {
    await loadModules();
    digestHost.openDigestHost();
    digestHost.closeDigestHost();

    mountAnchor(".right-container-inner", makeRect(1520, 80, 360, 2000));
    digestHost.openDigestHost();
    expect(vars(readingView()).width).toBe("400px");
  });

  it("未 open 时 close 是安全 no-op", async () => {
    await loadModules();
    expect(() => digestHost.closeDigestHost()).not.toThrow();
  });

  it("open 时 #boc-reading-view 不存在：静默不炸，后续重算可恢复", async () => {
    await loadModules();
    document.body.innerHTML = "";
    expect(() => digestHost.openDigestHost()).not.toThrow();

    // 元素后来出现（ui 渲染完成），下一次重算能写上变量。
    const view = document.createElement("div");
    view.id = "boc-reading-view";
    document.body.appendChild(view);
    mountAnchor(".right-container-inner", makeRect(1520, 80, 360, 2000));
    digestHost.refreshDigestHostRect();
    expect(vars(view).width).toBe("400px");
  });

  it("refreshDigestHostRect：手动重算一次，同步写变量", async () => {
    await loadModules();
    const anchor = mountAnchor(".right-container-inner", makeRect(1520, 80, 360, 2000));
    digestHost.openDigestHost();
    anchor.getBoundingClientRect = () => makeRect(1500, 40, 360, 1600) as DOMRect;

    digestHost.refreshDigestHostRect();

    // 锚点左缘 1500 → 视口右界 1920：宽 420；top 40，height = 768 - 40。
    expect(vars(readingView())).toEqual({
      left: "1500px",
      top: "40px",
      width: "420px",
      height: "728px"
    });
  });

  it("窄窗浮层 → 贴栏切换：重算后清浮层属性并写变量", async () => {
    await loadModules();
    window.innerWidth = 900;
    mountAnchor(".right-container-inner", makeRect(1640, 80, 280, 2000));

    digestHost.openDigestHost();

    const el = readingView();
    expect(el.getAttribute("data-boc-digest-float")).toBe("1");
    expect(vars(el)).toEqual({ left: "", top: "", width: "", height: "" });

    // 视口变宽后重算：恢复贴栏。锚点 rect 不随 innerWidth 变（左缘 1640），
    // 可填宽 1920-1640=280 < 下限 380 → 左缘左移到 1540，宽 380。
    window.innerWidth = 1920;
    digestHost.refreshDigestHostRect();
    expect(el.getAttribute("data-boc-digest-float")).toBe(null);
    expect(vars(el)).toEqual({
      left: "1540px",
      top: "80px",
      width: "380px",
      height: "688px"
    });
  });
});
