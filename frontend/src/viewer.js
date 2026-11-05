// 图片查看器（--image-viewer 模式独立窗口）
const $ = (id) => document.getElementById(id)
const stage = $('viewer-stage')
const img = $('viewer-img')
const label = $('vw-zoom-label')

const MIN_SCALE = 0.05
const MAX_SCALE = 40

let scale = 1
let tx = 0 // 平移（屏幕像素，相对 stage 左上）
let ty = 0
let fitScale = 1 // 适应窗口时的缩放比

function apply() {
  img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`
  label.textContent = `${Math.round(scale * 100)}%`
}

function center(offsetX = 0, offsetY = 0) {
  // 把图片居中放置（可选附加偏移）
  tx = (stage.clientWidth - img.naturalWidth * scale) / 2 + offsetX
  ty = (stage.clientHeight - img.naturalHeight * scale) / 2 + offsetY
}

function clampScale(s) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))
}

// 适应窗口：完整显示图片并居中
function fit() {
  if (!img.naturalWidth) return
  fitScale = Math.min(
    (stage.clientWidth - 32) / img.naturalWidth,
    (stage.clientHeight - 32) / img.naturalHeight,
  )
  fitScale = clampScale(fitScale)
  scale = fitScale
  center()
  apply()
}

// 100% 原始尺寸并居中
function actualSize() {
  scale = 1
  center()
  apply()
}

// 以 (cx, cy) 为锚点缩放（锚点保持不动）
function zoomAt(cx, cy, factor) {
  const next = clampScale(scale * factor)
  if (next === scale) return
  const k = next / scale
  tx = cx - k * (cx - tx)
  ty = cy - k * (cy - ty)
  scale = next
  apply()
}

// ---------- 滚轮缩放 ----------
stage.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    const rect = stage.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    zoomAt(cx, cy, e.deltaY < 0 ? 1.12 : 1 / 1.12)
  },
  { passive: false },
)

// ---------- 拖拽平移 ----------
let dragging = false
let dragStartX = 0
let dragStartY = 0
let startTx = 0
let startTy = 0

stage.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  dragging = true
  dragStartX = e.clientX
  dragStartY = e.clientY
  startTx = tx
  startTy = ty
  stage.classList.add('dragging')
  e.preventDefault()
})

window.addEventListener('mousemove', (e) => {
  if (!dragging) return
  tx = startTx + (e.clientX - dragStartX)
  ty = startTy + (e.clientY - dragStartY)
  apply()
})

window.addEventListener('mouseup', () => {
  dragging = false
  stage.classList.remove('dragging')
})

// ---------- 工具栏 ----------
$('vw-zoom-in').addEventListener('click', () => zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, 1.25))
$('vw-zoom-out').addEventListener('click', () => zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, 1 / 1.25))
$('vw-fit').addEventListener('click', fit)
$('vw-actual').addEventListener('click', actualSize)

// 双击：适应窗口 / 原始尺寸 切换
img.addEventListener('dblclick', () => {
  if (Math.abs(scale - fitScale) < 0.01) actualSize()
  else fit()
})

// 窗口尺寸变化时重新适应
window.addEventListener('resize', fit)

// ---------- 初始化 ----------
async function init() {
  const path = await window.go?.main?.Viewer?.ImagePath()
  if (!path) return
  img.addEventListener('load', fit, { once: true })
  img.src = '/local-file?path=' + encodeURIComponent(path)
}
init()
