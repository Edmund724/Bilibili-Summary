# 设置页下拉选择器统一到 custom-select 组件，放弃原生 select

设置页视觉统一（settings-ui-coherence 轮）收尾时，页面上还剩最后一个原生下拉「正文附加段落 - 段落位置」，它与已换壳的「下载格式」、Modal ASR 预设形成两族 affordance：原生一族渐变三角、自定义一族 chevron。我们决定：**设置页所有下拉选择器统一到 `custom-select` 组件**（`ui/custom-select.ts`），段落位置一并换壳；代价是原生 select 自带的键盘与读屏语义改由组件自担——listbox 键盘（↑/↓ 漫游不循环、Home/End、Enter/Space 开合与选中、Esc 归焦、Tab 穿行）+ ARIA（`aria-haspopup/expanded/controls`、`role=listbox/option`、`aria-selected`、roving tabindex），不做首字符 typeahead（选项都是 3~5 项短列表）。

## 考虑过的方案

- **A1：接受两族并存**（原生 select 保留渐变三角，自定义下拉用 chevron）：省掉组件的 a11y 维护，但与本轮统一目的相反，且段落位置会成为页面上唯一键控体验不同的控件。
- **A3：保留原生 select，用 CSS 把渐变三角重画成 chevron**：不引入组件维护成本，但两条细渐变拼出的 V 不可读，且渐变色只能写死 fallback——读不到 CSS 变量的 `background-image` 在深色档失配。

## 后果

- 原生 select 仍是值源与收集链：`collect*` 系列照读 `select.value`，组件写回值并派生 bubbling `change`，收集与校验逻辑零改。
- 隐藏正确性依赖 03 的提权规则：`.custom-select-hidden` 的尺寸/描边由宿主前置规则覆盖回，不依赖 clip 兜底；新增下拉来路必须落在带该提权的选择器域内。
- 页面上多一份非原生控件的 a11y 维护责任：键盘与 ARIA 语义收在 `custom-select.ts` 单文件内，三处调用点（下载格式、Modal ASR 预设、段落位置）共用；模型选择不套本方案——它是可输入的 combobox 语义，硬套 listbox 会误导读屏。
- 校验失败的 `input-error` 与焦点落在组件壳（`.custom-select-trigger`）上，原生 select 已被隐藏，直接标错会掉 1px 黑洞。

## 重开条件

若自定义下拉的读屏/键控体验明显劣于原生（实测口径：读屏念得出当前值与角色、纯键盘能改值），退回 A1 并接受两族 affordance。决策与验收记录见 `.scratch/tickets/settings-ui-coherence/issues/04-note-position-custom-select.md`。
