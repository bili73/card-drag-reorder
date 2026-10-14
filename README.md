# card-drag-reorder

长按拖动卡片交换排序 —— [Claude Code Skill](https://code.claude.com/docs/en/skills) + Vue 3 composable 二合一。

生产验证过的卡片拖拽排序完整机制：长按起拖、指针跟手、经过其他卡片即时交换、FLIP 滑位动画、松手滑入槽位，以及支撑它的全部工程细节（window 级指针监听、rAF 合帧、换位冷却、单拖拽不变式、Node 测试环境守卫）。这些细节每一条都对应一个真实修过的故障（卡死、回摆、僵尸卡），SKILL.md 里有逐条解释。

## 特性

- **长按起拖**（280ms，10px 位移阈值），不干扰普通点击
- **交换语义**：经过哪张卡就和哪张卡换位，带 14px 冷却距离防接缝振荡
- **FLIP 动画**：换位卡片滑动过去、被拖卡片松手滑入槽位，无瞬移
- **工程健壮性**：pointer capture 丢失（Vue 搬节点）、触屏多指竞态、主线程回流风暴均已处理
- **零依赖**：只用 `vue`（`ref`/`nextTick`），pointer events 原生实现

## 安装

### 方式一：作为 Claude Code Skill

把本仓库克隆到项目的 `.claude/skills/card-drag-reorder/`（或复制 `SKILL.md` 与 `useDragReorder.ts`），之后在 Claude Code 里涉及拖拽排序的对话会自动参考其中的机制与铁律。

### 方式二：直接使用 composable

1. 复制 [`useDragReorder.ts`](./useDragReorder.ts) 到你的 Vue 3 + TS 项目；
2. 在全局样式表加入两条动画类：

```css
/* 被拖卡片：浮起且对命中测试透明 */
.drag-reorder-dragging { z-index: 6; opacity: 0.92; box-shadow: 0 14px 34px rgba(16, 60, 54, 0.32); pointer-events: none; will-change: transform; transition: box-shadow .15s ease-out, opacity .15s ease-out; }
/* FLIP 滑位途中的卡片 */
.drag-reorder-flip { transition: transform 0.2s ease-out; will-change: transform; }
```

3. 组件里接入：

```ts
import { useDragReorder } from './useDragReorder'

const drag = useDragReorder({
  enabled: () => editMode.value,          // 何时允许起拖
  getOrder: () => layout.value ?? [],     // 当前顺序（与卡片 data-key 一致）
  setOrder: next => applyLayout(next),    // 交换后写回（组件侧负责持久化）
  gridSelector: '.my-grid',               // 网格容器；FLIP 捕获其内全部卡片（含占位卡）
  cardSelector: '.my-card',               // 可选，默认 '.type-card'；元素须带 data-key
  dropSlotSelector: '[data-plus-slot]',   // 可选外部落点（拖到其上高亮 .drag-over）
  onDropAtSlot: key => addEntry(key),     // 外部卡片落到落点
  onExternalDragEnd: key => { /* 可选：吞掉尾随 click 等 */ },
})
```

```html
<div class="my-grid">
  <button
    v-for="item in items"
    :key="item.key"
    class="my-card"
    :data-key="item.key"
    @pointerdown="drag.onCardPointerDown('grid', item.key, $event)"
  >...</button>
</div>
```

退出所在模式时调用 `drag.cancelGesture()`，组件卸载时调用 `drag.dispose()`。

## 机制与铁律

九条实现铁律（为什么监听必须挂 window、为什么滑位卡片要豁免命中、为什么需要换位冷却与单拖拽不变式等）与 Playwright 真实鼠标事件的验证配方，见 [`SKILL.md`](./SKILL.md)。修改 composable 本身前必读。

## 环境

- Vue >= 3.4（仅用 `ref` / `nextTick`）
- TypeScript（DOM lib）

## License

未设开源许可证，保留所有权利。如需在本组织外使用请联系作者。
