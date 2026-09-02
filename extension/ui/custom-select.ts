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

  options.forEach((opt) => {
    const li = document.createElement("li");
    li.className = "custom-select-option";
    li.dataset.value = opt.value;
    li.textContent = opt.label;
    if (opt.selected) li.dataset.selected = "true";
    dropdown.appendChild(li);
  });

  select.parentElement!.insertBefore(wrapper, select);
  wrapper.appendChild(select);
  select.classList.add("custom-select-hidden");
  wrapper.appendChild(trigger);
  wrapper.appendChild(dropdown);

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    document.querySelectorAll<HTMLElement>(".custom-select-dropdown").forEach((d) => {
      if (d !== dropdown) d.hidden = true;
    });
    dropdown.hidden = !dropdown.hidden;
  });

  dropdown.addEventListener("click", (e) => {
    const option = (e.target as HTMLElement).closest<HTMLElement>(".custom-select-option");
    if (!option) return;
    e.stopPropagation();
    const value = option.dataset.value;
    if (value === undefined) return;
    select.value = value;
    valueSpan.textContent = option.textContent || "";
    dropdown.querySelectorAll<HTMLElement>(".custom-select-option").forEach((o) => o.dataset.selected = "false");
    option.dataset.selected = "true";
    dropdown.hidden = true;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
