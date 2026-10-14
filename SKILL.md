---
name: card-drag-reorder
description: 长按拖动卡片交换排序（useDragReorder composable）—— 在工作台/网格类卡片 UI 中接入拖拽排序、修改或排查拖拽行为（卡死、回摆、动画生硬、僵尸卡）时使用。封装长按起拖、window 级指针监听、rAF 合帧、换位冷却、FLIP 滑位、松手落位与单拖拽不变式。
---

# 卡片长按拖动排序（useDragReorder）

机制实现在本仓库 [`useDragReorder.ts`](./useDragReorder.ts)（单一来源，Vue 3 + TypeScript composable），全局动画样式两条（`.drag-reorder-dragging` / `.drag-reorder-flip`，见 [README](./README.md) 安装一节）。已在生产工作台（12 入口卡片网格：长按交换 + ✕ 收纳 + 「+」位点选/拖回）中验证。

## 何时用 / 何时不用

- 用：卡片网格需要长按拖动换位、从外部容器（收纳箱/弹窗）拖回或拖出、松手滑入槽位等排序交互。
- 不用：单卡任意位置摆放（自由拖放）、跨容器列表 HTML5 DnD、一行文本的上下移（用按钮更简单）。

## 快速接入

```ts
import { useDragReorder } from '../useDragReorder.ts'

const drag = useDragReorder({
  enabled: () => editMode.value,            // 何时允许起拖
  getOrder: () => layout.value ?? [],       // 当前顺序（与卡片 data-key 一致）
  setOrder: next => applyLayout(next),      // 交换后写回（组件侧负责持久化）
  gridSelector: '.my-grid',                 // 网格容器；FLIP 捕获其内全部卡片（含占位卡）
  cardSelector: '.my-card',                 // 可选，默认 '.type-card'；元素须带 data-key
  dropSlotSelector: '[data-plus-slot]',     // 可选外部落点（拖到其上高亮 .drag-over）
  onDropAtSlot: key => addEntry(key),       // 外部卡片落到落点
  onExternalDragEnd: () => { /* 吞掉尾随 click 等 */ },
})
```

模板三件事：卡片 `:key` 用稳定业务键（绝不用 index，否则换位变成重挂载）、`@pointerdown="drag.onCardPointerDown('grid', key, $event)"`（外部来源传 `'external'`，它只认落点不做交换）、退出编辑模式时 `drag.cancelGesture()`、`onBeforeUnmount` 里 `drag.dispose()`。

## 机制与铁律（违反任意一条都会复现我们修过的故障）

1. **指针监听必须挂 window（按 pointerId 过滤），不能挂卡片**：换位时 Vue 会把被拖 DOM 节点搬到新槽位，节点离开文档树即丢失 pointer capture，卡片上的监听从此收不到 pointerup —— 拖拽态永久泄漏成僵尸卡（pointer-events:none、僵在半空，刷新才能恢复）。
2. **单拖拽不变式**：`windowDetach || draggingKey` 非空时忽略新 pointerdown。触屏第二根手指/手掌误触否则会摘掉前一指针的监听并覆盖 holdTimer，把前一卡片永久僵死。
3. **pointermove 只记坐标 + rAF 合帧**：写 transform 与 elementFromPoint 读布局成对发生在同一帧。每个 pointermove 都直接命中测试 + 强制回流，接缝处能把主线程刷满（用户原话"多交换两次界面就卡死"）。
4. **换位冷却 SWAP_REARM_PX=14px**：换位后指针须再移动这段距离才允许下一次换位。否则指针停在两槽接缝时，微动会让两张卡来回互换（振荡风暴）。
5. **滑位中的卡片豁免命中**：FLIP 途中被拖卡片仍覆盖在指针下方，若参与命中会立刻换回（回摆）。命中测试跳过 `.drag-reorder-flip` 元素。
6. **被拖卡片 pointer-events:none + 松手 settle 滑入**：命中测试穿透才能看到下面的交换目标；松手从视觉位置 FLIP 滑回槽位，不瞬移。
7. **capture 让 pointerup 仍派发到原卡片 → 拖拽结束会带出一个 click**：外部来源拖放必须吞掉这个尾随 click（onExternalDragEnd 里置抑制标记），否则"拖完又点选"重复添加。
8. **Node 测试环境守卫**：`stopDrag`/`clearDropHighlight`/`dispose` 会在无 window/document 的单测里执行（组件被直接挂载的环境），document 访问必须 `typeof document === 'undefined'` 惰性守卫；卸载路径上的定时用裸 `clearTimeout`（globalThis），不要写 `window.clearTimeout`；模块顶层不得触碰 window。
9. **退出编辑模式要 `cancelGesture()`**（不只是 stopDrag）：清掉未落地的长按定时与 window 监听，否则点「完成」后的残留定时仍会起拖并写入布局。

## 验证配方（Playwright 真实鼠标事件）

临时脚手架（用完即删，不入库）：Vite dev server（strictPort）+ 只挂目标组件的 harness 页（必须同时引全局样式文件，否则网格布局失真、验证白做）+ `playwright-core` 驱动系统 Edge（`chromium.launch({ channel: 'msedge', headless: true })`）。断言：

1. **交换**：`mouse.down` → 停 420ms（超长按阈值）→ `move steps:12` → 采样顺序（拖动中）→ `up` → 再采样。两次都应交换且一致（不一致 = 回摆）。
2. **落位清理**：松手 350ms 后无 `.drag-reorder-dragging` / `.drag-reorder-flip` 残留、无内联 transform。
3. **振荡探针**：指针停在两卡接缝做 40 次 ±3px 微动，顺序不变、`evaluate` 往返 < 50ms（页面未被打满）。
4. **多次换位**：连续拖两次都成功（第一次换位后 capture/监听仍活着）。
5. **外部路径**：✕ 收纳 → 点「+」/ 拖到「+」→ 计数与持久化（刷新后顺序保持）、localStorage 无重复 key。
6. 全程监听 `pageerror`，必须为零。

修改拖拽机制本身时：先跑上述全流程，再 `typecheck && test && build`（build 必须无条件执行）。
