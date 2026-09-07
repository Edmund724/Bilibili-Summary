// 自定义下拉组件（ADR-0007：设置页下拉统一到本组件）。原生 select 仍是值源
// 与表单收集链，组件只做展示与交互壳；listbox 键盘与 ARIA 语义在组件内自持：
// trigger 上 Enter/Space 展开，↑/↓ 在选项间漫游（首尾不循环），Home/End 跳首尾，
// Enter/Space 选中并关闭，Esc 关闭归焦 trigger，Tab 关闭并正常离开。

let customSelectSeq = 0;

// 关闭全部下拉并同步 aria-expanded（外点关闭委托与组件内切换共用，避免
// hidden 复位了 aria 没复位）
export function closeAllCustomSelects(except?: HTMLElement): void {
  document.querySelectorAll<HTMLElement>(".custom-select-dropdown").forEach((dropdown) => {
    if (dropdown === except) return;
    dropdown.hidden = true;
    dropdown.closest(".custom-select-wrapper")?.querySelector<HTMLButtonElement>(".custom-select-trigger")?.setAttribute("aria-expanded", "false");
  });
}

export function initCustomSelect(select: HTMLSelectElement, wrapperClass = "custom-select-wrapper"): void {
  if (select.dataset.customSelectInitialized === "1") return;
  select.dataset.customSelectInitialized = "1";

  const options = Array.from(select.options).map((o) => ({
    value: o.value,
    label: o.textContent || o.value,
    selected: o.selected
  }));

  const currentValue = select.value;

  const wrapper = document.createElement("div");
  wrapper.className = wrapperClass;

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "custom-select-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");

  const valueSpan = document.createElement("span");
  valueSpan.className = "custom-select-value";
  const currentOption = options.find((o) => o.value === currentValue) || options[0];
  valueSpan.textContent = currentOption?.label || "";

  const arrow = document.createElement("span");
  arrow.className = "custom-select-arrow";
  arrow.innerHTML = `<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"></path></svg>`;

  trigger.appendChild(valueSpan);
  trigger.appendChild(arrow);

  const dropdown = document.createElement("ul");
  dropdown.className = "custom-select-dropdown";
  dropdown.hidden = true;
  dropdown.id = `custom-select-dropdown-${++customSelectSeq}`;
  dropdown.setAttribute("role", "listbox");
  const selectLabel = select.getAttribute("aria-label");
  if (selectLabel) {
    dropdown.setAttribute("aria-label", selectLabel);
  }
  trigger.setAttribute("aria-controls", dropdown.id);

  options.forEach((opt) => {
    const li = document.createElement("li");
    li.className = "custom-select-option";
    li.dataset.value = opt.value;
    li.textContent = opt.label;
    li.setAttribute("role", "option");
    li.tabIndex = -1;
    if (opt.selected) {
      li.dataset.selected = "true";
      li.setAttribute("aria-selected", "true");
    } else {
      li.dataset.selected = "false";
      li.setAttribute("aria-selected", "false");
    }
    dropdown.appendChild(li);
  });

  select.parentElement!.insertBefore(wrapper, select);
  wrapper.appendChild(select);
  select.classList.add("custom-select-hidden");
  wrapper.appendChild(trigger);
  wrapper.appendChild(dropdown);

  const optionNodes = Array.from(dropdown.querySelectorAll<HTMLElement>(".custom-select-option"));

  const setExpanded = (open: boolean): void => {
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
  };

  const markSelected = (option: HTMLElement): void => {
    optionNodes.forEach((o) => {
      o.dataset.selected = "false";
      o.setAttribute("aria-selected", "false");
    });
    option.dataset.selected = "true";
    option.setAttribute("aria-selected", "true");
  };

  // 展开时收掉同族其它下拉（外点关闭委托只管 click，键盘路径在此自持）
  const openList = (): void => {
    closeAllCustomSelects(dropdown);
    dropdown.hidden = false;
    setExpanded(true);
    (optionNodes.find((o) => o.dataset.selected === "true") || optionNodes[0])?.focus();
  };

  const closeList = (refocusTrigger: boolean): void => {
    dropdown.hidden = true;
    setExpanded(false);
    if (refocusTrigger) trigger.focus();
  };

  const chooseOption = (option: HTMLElement): void => {
    const value = option.dataset.value;
    if (value === undefined) return;
    select.value = value;
    valueSpan.textContent = option.textContent || "";
    markSelected(option);
    closeList(true);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  };

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (dropdown.hidden) {
      openList();
    } else {
      closeList(true);
    }
  });

  trigger.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openList();
    }
  });

  dropdown.addEventListener("keydown", (e) => {
    const active = document.activeElement;
    const current = active instanceof HTMLElement && optionNodes.includes(active)
      ? optionNodes.indexOf(active)
      : optionNodes.findIndex((o) => o.dataset.selected === "true");
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown"
        ? optionNodes[Math.min(optionNodes.length - 1, current + 1)]
        : optionNodes[Math.max(0, current - 1)];
      next?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      optionNodes[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      optionNodes[optionNodes.length - 1]?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const option = optionNodes[current];
      if (option) chooseOption(option);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeList(true);
    } else if (e.key === "Tab") {
      // 只收拢列表，不抢焦点：Tab 正常离开组件
      dropdown.hidden = true;
      setExpanded(false);
    }
  });

  dropdown.addEventListener("click", (e) => {
    const option = (e.target as HTMLElement).closest<HTMLElement>(".custom-select-option");
    if (!option) return;
    e.stopPropagation();
    chooseOption(option);
  });
}
