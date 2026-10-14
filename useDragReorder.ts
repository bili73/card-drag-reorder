// 长按拖动卡片交换排序的可复用机制（工作台入口编辑模式同款）。
// 封装：长按起拖、window 级指针监听（pointerId 过滤）、rAF 合帧、换位冷却、FLIP 滑位、松手落位、单拖拽不变式。
// 机制说明与铁律见 .claude/skills/card-drag-reorder/SKILL.md；改动任何一条前先读那里的「为什么」。
import { nextTick, ref } from 'vue'

export const DRAG_HOLD_MS = 280
export const DRAG_MOVE_THRESHOLD = 10
export const SWAP_REARM_PX = 14
export const FLIP_MS = 200
/** 被拖卡片类（全局样式见 style.css）：pointer-events:none 让命中测试穿到下面的卡片。 */
export const DRAG_CLASS = 'drag-reorder-dragging'
/** FLIP 滑位途中的卡片类：换位命中测试必须豁免它，否则会立刻回摆。 */
export const FLIP_CLASS = 'drag-reorder-flip'

export interface DragReorderOptions {
  /** 是否允许起拖（如仅编辑模式）；pointerdown 与长按落地时各复核一次。 */
  enabled: () => boolean
  /** 可排序网格的当前顺序（与卡片 data-key 一致）。 */
  getOrder: () => string[]
  /** 交换后写回顺序；组件侧负责响应式更新与持久化。 */
  setOrder: (next: string[]) => void
  /** 网格容器选择器；FLIP 滑位捕获其内部全部 cardSelector 元素（含占位卡）。 */
  gridSelector: string
  /** 参与交换的卡片选择器（元素须带 data-key）；默认 '.type-card'。 */
  cardSelector?: string
  /** 外部落点选择器（如「+」位 data-plus-slot）；外部来源卡片拖到它上方时高亮并放置。 */
  dropSlotSelector?: string
  /** 外部来源卡片被放到落点时回调（如从收纳箱添加回工作台）。 */
  onDropAtSlot?: (key: string) => void
  /** 外部来源拖拽结束（无论是否落到落点）；用于吞掉 capture 造成的尾随 click。 */
  onExternalDragEnd?: (key: string) => void
}

export function useDragReorder(options: DragReorderOptions) {
  const cardSelector = options.cardSelector ?? '.type-card'
  const draggingKey = ref<string | null>(null)
  let dragSource: 'grid' | 'external' | null = null
  let holdTimer: number | undefined
  let dragFrame = 0
  let draggedEl: HTMLElement | null = null
  let grab = { x: 0, y: 0 }
  let natural = { x: 0, y: 0 }
  let lastPointer = { x: 0, y: 0 }
  let lastSwap = { x: -1e9, y: -1e9 }
  let flipTimers: number[] = []
  let windowDetach: (() => void) | null = null

  function detachWindowPointerHandlers() { windowDetach?.(); windowDetach = null }
  function flushFlips() {
    // 立即终结在途的滑位动画并清掉内联 transform，保证后续 rect 读取干净。
    if (typeof document === 'undefined') return
    document.querySelectorAll<HTMLElement>(`.${FLIP_CLASS}`).forEach(el => {
      el.classList.remove(FLIP_CLASS)
      el.style.transition = ''
      el.style.transform = ''
    })
    flipTimers.forEach(t => clearTimeout(t))
    flipTimers = []
  }
  function glideCard(el: HTMLElement, dx: number, dy: number) {
    // FLIP：先把元素放回旧位置（关过渡），强制回流后清 transform，让 class 过渡接手滑向新位置。
    el.style.transform = `translate(${dx}px, ${dy}px)`
    el.style.transition = 'none'
    el.getBoundingClientRect()
    el.classList.add(FLIP_CLASS)
    el.style.transition = ''
    el.style.transform = ''
    flipTimers.push(window.setTimeout(() => {
      el.classList.remove(FLIP_CLASS)
      el.style.transition = ''
    }, FLIP_MS + 60))
  }
  function followPointer() {
    if (!draggedEl) return
    draggedEl.style.transform = `translate3d(${lastPointer.x - grab.x - natural.x}px, ${lastPointer.y - grab.y - natural.y}px, 0) scale(1.04)`
  }
  function recomputeNatural() {
    if (!draggedEl) return
    const prev = draggedEl.style.transform
    draggedEl.style.transform = ''
    const rect = draggedEl.getBoundingClientRect()
    natural = { x: rect.left, y: rect.top }
    draggedEl.style.transform = prev
    followPointer()
  }
  function scheduleDragFrame() {
    // 把 pointermove 的高频事件合到每帧一次：写 transform 与读布局（elementFromPoint）成对发生在同一帧，避免反复回流。
    if (dragFrame) return
    dragFrame = window.requestAnimationFrame(() => {
      dragFrame = 0
      if (!draggingKey.value || !draggedEl) return
      followPointer()
      if (dragSource === 'grid') hoverSwap(lastPointer.x, lastPointer.y)
      else highlightDropSlot()
    })
  }
  function highlightDropSlot() {
    if (!options.dropSlotSelector) return
    const plus = document.elementFromPoint(lastPointer.x, lastPointer.y)?.closest(options.dropSlotSelector)
    plus?.classList.add('drag-over')
    document.querySelectorAll(`${options.dropSlotSelector}.drag-over`).forEach(el => { if (el !== plus) el.classList.remove('drag-over') })
  }
  function clearDropHighlight() {
    if (typeof document === 'undefined' || !options.dropSlotSelector) return // Node 测试环境只走 setup/unmount，无 document。
    document.querySelectorAll(`${options.dropSlotSelector}.drag-over`).forEach(el => el.classList.remove('drag-over'))
  }
  function hoverSwap(x: number, y: number) {
    const order = options.getOrder()
    if (!order.length || !draggingKey.value) return
    // 换位冷却：指针离开上次换位点不足 SWAP_REARM_PX 前不再换位，否则接缝处微动会让两张卡来回互换刷爆渲染。
    if (Math.hypot(x - lastSwap.x, y - lastSwap.y) < SWAP_REARM_PX) return
    const hit = document.elementFromPoint(x, y)?.closest(`${cardSelector}[data-key]`) as HTMLElement | null
    // 滑位途中的卡片目标槽位还没到位，命中它会造成立刻换回（回摆），等它落定再参与换位判定。
    if (hit?.classList.contains(FLIP_CLASS)) return
    const targetKey = hit?.dataset.key
    if (!targetKey || targetKey === draggingKey.value) return
    const next = [...order]
    const a = next.indexOf(draggingKey.value), b = next.indexOf(targetKey)
    if (a < 0 || b < 0) return
    ;[next[a], next[b]] = [next[b]!, next[a]!]
    // FLIP：换位前记录网格内各卡位置，DOM 重排后让它们滑到新槽位；被拖卡片本身保持跟手。
    flushFlips()
    const before = new Map<HTMLElement, DOMRect>()
    document.querySelectorAll<HTMLElement>(`${options.gridSelector} ${cardSelector}`).forEach(el => before.set(el, el.getBoundingClientRect()))
    options.setOrder(next)
    lastSwap = { x, y }
    void nextTick(() => {
      const moves: Array<[HTMLElement, number, number]> = []
      before.forEach((prev, el) => {
        if (el === draggedEl) return
        const now = el.getBoundingClientRect()
        const dx = prev.left - now.left, dy = prev.top - now.top
        if (dx || dy) moves.push([el, dx, dy])
      })
      moves.forEach(([el, dx, dy]) => glideCard(el, dx, dy))
      recomputeNatural()
    })
  }
  function settleCard(el: HTMLElement) {
    // 松手落位：从松手时的视觉位置滑回最终槽位，替代瞬间吸附。
    const vx = lastPointer.x - grab.x, vy = lastPointer.y - grab.y
    el.style.transform = ''
    const rect = el.getBoundingClientRect()
    const dx = vx - rect.left, dy = vy - rect.top
    el.classList.remove(DRAG_CLASS)
    el.style.touchAction = ''
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return
    glideCard(el, dx, dy)
  }
  function stopDrag() {
    if (dragFrame) { window.cancelAnimationFrame(dragFrame); dragFrame = 0 }
    draggingKey.value = null
    dragSource = null
    clearDropHighlight()
    if (draggedEl) {
      draggedEl.classList.remove(DRAG_CLASS)
      draggedEl.style.transform = ''
      draggedEl.style.touchAction = ''
    }
    draggedEl = null
  }
  function onCardPointerDown(source: 'grid' | 'external', key: string, event: PointerEvent) {
    if (!options.enabled() || event.button !== 0) return
    // 单拖拽不变式：已有手势在途（长按待起或拖动中）时忽略新指针。触屏第二指/手掌误触否则会摘掉
    // 前一指针的监听并覆盖 holdTimer，把前一卡片永久僵死在拖拽态。
    if (windowDetach || draggingKey.value) return
    const el = event.currentTarget as HTMLElement
    const startX = event.clientX, startY = event.clientY
    const pointerId = event.pointerId
    let armed = true
    // move/up 监听挂 window（按 pointerId 过滤）：换位时 Vue 会搬动被拖节点，节点离开文档树会丢
    // pointer capture，挂在本节点上的监听收不到后续事件，拖拽状态就僵死在半空。
    detachWindowPointerHandlers()
    try { el.setPointerCapture(pointerId) } catch { /* 指针已失效时忽略 */ }
    holdTimer = window.setTimeout(() => {
      if (!armed || !options.enabled()) return
      armed = false
      el.style.touchAction = 'none'
      flushFlips()
      draggingKey.value = key
      dragSource = source
      draggedEl = el
      const rect = el.getBoundingClientRect()
      grab = { x: startX - rect.left, y: startY - rect.top }
      natural = { x: rect.left, y: rect.top }
      lastPointer = { x: startX, y: startY }
      lastSwap = { x: -1e9, y: -1e9 }
      el.classList.add(DRAG_CLASS)
      followPointer()
    }, DRAG_HOLD_MS)
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return
      if (draggingKey.value) {
        lastPointer = { x: e.clientX, y: e.clientY }
        scheduleDragFrame()
        return
      }
      if (!armed || Math.hypot(e.clientX - startX, e.clientY - startY) <= DRAG_MOVE_THRESHOLD) return
      armed = false
      window.clearTimeout(holdTimer)
    }
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return
      window.clearTimeout(holdTimer)
      detachWindowPointerHandlers()
      if (draggingKey.value) {
        const source = dragSource, key = draggingKey.value, el = draggedEl
        lastPointer = { x: e.clientX, y: e.clientY }
        if (source === 'external') {
          if (options.dropSlotSelector) {
            const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest(options.dropSlotSelector)
            if (hit) options.onDropAtSlot?.(key)
          }
          options.onExternalDragEnd?.(key)
        } else if (el) {
          settleCard(el)
        }
        stopDrag()
      }
    }
    windowDetach = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }
  /** 撤掉未落地的手势（长按定时、window 监听、拖拽态）；用于退出编辑模式等场景。 */
  function cancelGesture() {
    clearTimeout(holdTimer) // 裸全局：浏览器与 Node 测试环境（无 window）都可用。
    detachWindowPointerHandlers()
    stopDrag()
  }
  /** 组件卸载前的最终清理；onBeforeUnmount 调用。 */
  function dispose() {
    cancelGesture()
    flipTimers.forEach(t => clearTimeout(t))
    flipTimers = []
  }
  return { draggingKey, onCardPointerDown, cancelGesture, dispose }
}
