import './style.css'
import { EditorView, keymap, Decoration } from '@codemirror/view'
import { EditorState, StateEffect, StateField } from '@codemirror/state'
import {
  history,
  defaultKeymap,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { tags as t } from '@lezer/highlight'
import {
  createEditor,
  getMarkdown,
  setMarkdown,
  countWords,
  setSearchHighlight,
} from './editor.js'

// ---------- Wails 运行时绑定（wails dev / build 时由桥接注入） ----------
const wails = () => window.go?.main?.App

// ---------- DOM ----------
const $ = (id) => document.getElementById(id)
const elTitle = $('file-title')
const elModeBtn = $('btn-mode')
const elWords = $('status-words')
const elMode = $('status-mode')
const elDirty = $('status-dirty')
const elPath = $('status-path')
const elReveal = $('status-reveal')
const elTiptapWrap = $('tiptap-editor')
const elSourceWrap = $('source-wrap')
const elSource = $('source-editor')

// ---------- 状态 ----------
let currentPath = '' // 显示用文件路径
let dirty = false
let mode = 'wysiwyg' // 'wysiwyg' | 'source'
let docOpen = false // 是否已进入编辑状态（新建/打开后为 true，启动页不再出现）
let rawMarkdown = '' // 打开/保存时的文件原文（源码模式直接显示它，不做序列化转换）
let wysiwygEdited = false // 所见即所得里是否改过内容
let sourceDirty = false // 源码模式里是否改过内容（切回时需要重新解析）

function baseName(p) {
  if (!p) return '未命名'
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i >= 0 ? p.slice(i + 1) : p
}

// 标题栏显示用文件名（隐藏 .md 扩展名）
function displayName(p) {
  return baseName(p).replace(/\.(md|markdown)$/i, '')
}

function dirName(p) {
  if (!p) return ''
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i > 0 ? p.slice(0, i) : ''
}

function refreshHeader() {
  elTitle.textContent = displayName(currentPath) + (dirty ? ' ●' : '')
  elTitle.title = currentPath ? '点击重命名' : ''
  elDirty.textContent = dirty ? '未保存' : '已保存'
  // 状态栏显示工作区目录（而不是当前笔记所在的子目录）
  elPath.textContent = workspacePath
  elPath.title = workspacePath
  // 打开工作区后才显示「打开所在目录」
  elReveal.classList.toggle('hidden', !workspacePath)
}

// ---------- 标题栏点击重命名 ----------
let renaming = false

async function startRename() {
  if (renaming) return
  if (!currentPath) {
    elDirty.textContent = '请先打开一篇笔记'
    return
  }
  renaming = true

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'title-input'
  input.value = displayName(currentPath)
  elTitle.textContent = ''
  elTitle.appendChild(input)
  input.focus()
  input.select()

  let done = false
  const finish = async (commit) => {
    if (done) return
    done = true
    const val = input.value.trim()
    elTitle.textContent = ''
    renaming = false

    if (commit && val && val !== displayName(currentPath)) {
      const app = wails()
      if (app) {
        try {
          const newPath = await app.RenameEntry(currentPath, val)
          if (newPath) currentPath = newPath
          await refreshTree()
        } catch (e) {
          alert('重命名失败: ' + e)
        }
      }
    }
    refreshHeader()
    if (!commit) editor.commands.focus()
  }

  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      finish(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      finish(false)
    }
  })
  input.addEventListener('blur', () => finish(true))
  // 点击输入框内不触发外层点击
  input.addEventListener('click', (e) => e.stopPropagation())
}

elTitle.addEventListener('click', startRename)

function refreshStats(md) {
  elWords.textContent = `${countWords(md)} 字`
}

function markDirty() {
  if (!dirty) {
    dirty = true
    refreshHeader()
  }
  scheduleAutoSave()
}

// ---------- 自动保存（防抖 2s，仅用于已命名的文件） ----------
let autoSaveTimer = null

function scheduleAutoSave() {
  clearTimeout(autoSaveTimer)
  autoSaveTimer = setTimeout(autoSave, 2000)
}

function nowTime() {
  return new Date().toTimeString().slice(0, 5)
}

async function autoSave() {
  const app = wails()
  if (!app) return
  if (!currentPath) return // 未命名文档不自动保存；关闭时询问「保留 / 废弃」
  try {
    const md = currentMarkdown()
    await app.SaveMarkdown(md)
    rawMarkdown = md
    if (mode === 'wysiwyg' && lastMarkdown === md) wysiwygEdited = false
    dirty = false
    refreshHeader()
    elDirty.textContent = `已自动保存 ${nowTime()}`
  } catch (e) {
    console.error('自动保存失败', e)
  }
}

// ---------- 图片上传（落盘到 Go 端，按设置决定位置） ----------
async function uploadImage(file) {
  const app = wails()
  if (!app) return null
  const dataURL = await new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = reject
    r.readAsDataURL(file)
  })
  return app.SaveImage(file.name, dataURL)
}

// ---------- Tiptap ----------
// 最近一次内容；链接展开成原文等视图层变化不改变 Markdown，不应标记为已修改
let lastMarkdown = ''

const editor = createEditor(elTiptapWrap, {
  onUpdate: (md) => {
    if (md === lastMarkdown) return
    lastMarkdown = md
    wysiwygEdited = true
    markDirty()
    refreshStats(md)
    refreshOutline()
  },
  getCurrentDir: () => dirName(currentPath),
  uploadImage,
  downloadImage: (url) => wails()?.DownloadImage(url),
  // 仅所见即所得模式下自动把 [名称](地址) 转成链接
  canAutoConvert: () => mode === 'wysiwyg',
})

// 编辑区滚动容器（注意：$ 是 getElementById 的简写，此处须用 querySelector）
const editorScrollWrap = document.querySelector('.editor-wrap')

// ---------- 源码模式：CodeMirror 6（显示文件原文） ----------
// 不做实时同步进 tiptap：源码里改过，切回所见即所得时再用原文重新解析，
// 保证解析结果与文件原文完全一致。

// Markdown / 围栏代码块的语法高亮配色：直接用全局 CSS 变量，亮暗主题自动跟随
const cmHighlight = HighlightStyle.define([
  { tag: t.heading, color: 'var(--hl-title)', fontWeight: 'bold' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.url, color: 'var(--accent)' },
  { tag: t.monospace, color: 'var(--hl-string)' },
  { tag: t.quote, color: 'var(--quote-fg)' },
  { tag: t.processingInstruction, color: 'var(--fg-soft)' }, // #、**、``` 等记号
  { tag: t.contentSeparator, color: 'var(--fg-soft)' }, // ---
  { tag: t.meta, color: 'var(--fg-soft)' },
  { tag: t.keyword, color: 'var(--hl-keyword)' },
  { tag: t.atom, color: 'var(--hl-builtin)' },
  { tag: t.string, color: 'var(--hl-string)' },
  { tag: t.number, color: 'var(--hl-number)' },
  { tag: t.comment, color: 'var(--hl-comment)' },
  { tag: t.variableName, color: 'var(--hl-attr)' },
  { tag: t.typeName, color: 'var(--hl-builtin)' },
  { tag: t.propertyName, color: 'var(--hl-attr)' },
  { tag: t.labelName, color: 'var(--hl-builtin)' },
])

// 查找匹配的 CM 装饰层（find-mark / find-mark-active）
const setFindEffect = StateEffect.define()
const findField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) if (e.is(setFindEffect)) deco = e.value
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

let sourceProgrammatic = false // 程序性改写（切模式/载入文件）不算源码编辑

const cmView = new EditorView({
  parent: elSource,
  state: EditorState.create({
    doc: '',
    extensions: [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      syntaxHighlighting(cmHighlight),
      EditorView.lineWrapping,
      EditorState.tabSize.of(2),
      findField,
      EditorView.updateListener.of((u) => {
        if (!u.docChanged || sourceProgrammatic) return
        scheduleFindRefresh()
        sourceDirty = true
        markDirty()
        refreshStats(getSourceText())
        refreshOutline()
      }),
    ],
  }),
})

function getSourceText() {
  return cmView.state.doc.toString()
}

function setSourceText(text) {
  const cur = getSourceText()
  if (cur === text) return
  sourceProgrammatic = true
  cmView.dispatch({ changes: { from: 0, to: cur.length, insert: text } })
  sourceProgrammatic = false
}

// 把查找匹配刷进 CM 装饰层
function renderSourceHighlight() {
  const ranges = []
  const len = cmView.state.doc.length
  if (findBarOpen()) {
    for (let i = 0; i < findMatches.length; i += 1) {
      const m = findMatches[i]
      if (m.from >= len) break
      const cls = i === findActive ? 'find-mark find-mark-active' : 'find-mark'
      ranges.push(Decoration.mark({ class: cls }).range(m.from, Math.min(m.to, len)))
    }
  }
  cmView.dispatch({ effects: setFindEffect.of(Decoration.set(ranges, true)) })
}

// 把源码的某个字符位置滚到页面可视区约 1/3 处
function scrollSourceOffsetTo(offset, ratio = 1 / 3) {
  const wrap = editorScrollWrap
  if (!wrap) return
  const coords = cmView.coordsAtPos(Math.min(offset, cmView.state.doc.length))
  if (!coords) return
  const wrapRect = wrap.getBoundingClientRect()
  wrap.scrollTop = Math.max(
    0,
    wrap.scrollTop + (coords.top - wrapRect.top) - wrap.clientHeight * ratio,
  )
}

// ---------- 源码行 ↔ 所见即所得块 的近似映射 ----------
// 每个块记录它在文件文本里的起始行；切换模式时据此把光标放到对应/附近行
let blockLineMap = [] // [{ pos, node, line }]

function buildBlockLineMap(markdown, doc) {
  const srcLines = markdown.split('\n')
  const blocks = []
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      blocks.push({ pos, node, text: (node.textContent || '').trim() })
      return false
    }
    return true
  })
  const map = []
  let searchFrom = 0
  for (const block of blocks) {
    const first = block.text.split('\n')[0].trim().slice(0, 60)
    let line = -1
    if (first) {
      for (let i = searchFrom; i < srcLines.length; i += 1) {
        if (srcLines[i].includes(first)) {
          line = i
          break
        }
      }
      if (line < 0) {
        for (let i = 0; i < srcLines.length; i += 1) {
          if (srcLines[i].includes(first)) {
            line = i
            break
          }
        }
      }
    }
    if (line < 0) line = Math.min(searchFrom, Math.max(0, srcLines.length - 1))
    else searchFrom = line
    map.push({ pos: block.pos, node: block.node, line })
  }
  return map
}

// 光标文档位置 → 源码行（代码块按块内换行数偏移）
function sourceLineAt(pos) {
  if (!blockLineMap.length) return 0
  let entry = blockLineMap[0]
  for (const item of blockLineMap) {
    if (item.pos <= pos) entry = item
    else break
  }
  let line = entry.line
  if (entry.node?.type?.name === 'codeBlock') {
    const before = entry.node.textContent.slice(0, Math.max(0, pos - (entry.pos + 1)))
    line += (before.match(/\n/g) || []).length
  }
  return line
}

// 源码行 → 文档位置（放进对应块里）
function docPosAtLine(line) {
  if (!blockLineMap.length) return 1
  let entry = blockLineMap[0]
  for (const item of blockLineMap) {
    if (item.line <= line) entry = item
    else break
  }
  let pos = entry.pos + 1
  if (entry.node?.type?.name === 'codeBlock') {
    const codeLines = entry.node.textContent.split('\n')
    const offset = Math.max(0, Math.min(line - entry.line, codeLines.length - 1))
    for (let i = 0; i < offset; i += 1) pos += codeLines[i].length + 1
  }
  return Math.min(pos, editor.state.doc.content.size)
}

function sourceCaretLine() {
  const head = cmView.state.selection.main.head
  return cmView.state.doc.lineAt(head).number - 1
}

// 切换模式时的定位锚点：取视口约 1/3 处正在看的内容，而不是光标位置
// （光标可能停在很上面，但人已经滚到下面看了）
function wysiwygViewportAnchorPos() {
  const wrap = editorScrollWrap
  if (!wrap) return editor.state.selection.from
  const r = wrap.getBoundingClientRect()
  const hit = editor.view.posAtCoords({
    left: r.left + r.width / 2,
    top: r.top + r.height / 3,
  })
  return hit ? hit.pos : editor.state.selection.from
}

function sourceViewportLine() {
  const wrap = editorScrollWrap
  if (!wrap) return sourceCaretLine()
  const r = wrap.getBoundingClientRect()
  const pos = cmView.posAtCoords({
    x: r.left + r.width / 2,
    y: r.top + r.height / 3,
  })
  if (pos == null) return sourceCaretLine()
  return cmView.state.doc.lineAt(pos).number - 1
}

// 源码模式：把光标放到对应行，并滚到可视区约 1/3 处
function placeSourceCaret(line) {
  const doc = cmView.state.doc
  const target = Math.max(1, Math.min(line + 1, doc.lines))
  const offset = doc.line(target).from
  cmView.focus()
  cmView.dispatch({ selection: { anchor: offset } })
  requestAnimationFrame(() => scrollSourceOffsetTo(offset))
}

// 所见即所得：滚动到光标处，放在可视区约 1/3 位置
function scrollCaretToThird() {
  const wrap = editorScrollWrap
  if (!wrap) return
  requestAnimationFrame(() => {
    let rect = null
    try {
      const sel = window.getSelection()
      if (sel && sel.rangeCount) rect = sel.getRangeAt(0).getBoundingClientRect()
    } catch {
      rect = null
    }
    if (!rect || (!rect.height && !rect.top)) {
      try {
        const res = editor.view.domAtPos(editor.state.selection.from)
        const el = res.node.nodeType === 1 ? res.node : res.node.parentElement
        rect = el?.getBoundingClientRect() || null
      } catch {
        rect = null
      }
    }
    if (!rect) return
    const wrapRect = wrap.getBoundingClientRect()
    wrap.scrollTop = Math.max(
      0,
      wrap.scrollTop + (rect.top - wrapRect.top) - wrapRect.height / 3,
    )
  })
}

// ---------- 模式切换 ----------
function setMode(next) {
  if (next === mode) return
  // 没有打开笔记时不允许切源码
  if (!currentPath) return
  if (next === 'source') {
    // 没有改过所见即所得 → 直接显示打开/保存时的文件原文，避免序列化改写
    let text = rawMarkdown
    if (wysiwygEdited) {
      text = getMarkdown(editor)
      rawMarkdown = text
      wysiwygEdited = false
    }
    // 先记住视口 1/3 处在原文中的行，再切过去
    blockLineMap = buildBlockLineMap(text, editor.state.doc)
    const caretLine = sourceLineAt(wysiwygViewportAnchorPos())
    mode = 'source'
    document.body.classList.add('source-mode')
    setSourceText(text)
    sourceDirty = false
    elTiptapWrap.classList.add('hidden')
    elSourceWrap.classList.remove('hidden')
    elMode.textContent = '源码模式'
    placeSourceCaret(caretLine)
  } else {
    // 记住源码里视口 1/3 处的行；源码改过就用原文重新解析，保证所见即所得准确
    const line = sourceViewportLine()
    const text = getSourceText()
    mode = 'wysiwyg'
    document.body.classList.remove('source-mode')
    if (sourceDirty) {
      loadContent(text)
    } else {
      blockLineMap = buildBlockLineMap(text, editor.state.doc)
    }
    elSourceWrap.classList.add('hidden')
    elTiptapWrap.classList.remove('hidden')
    elMode.textContent = '所见即所得'
    try {
      editor.chain().focus().setTextSelection(docPosAtLine(line)).run()
    } catch {
      editor.commands.focus()
    }
    scrollCaretToThird()
  }
  // 按钮始终保持 SVG 图标，只切换高亮状态与提示文字
  elModeBtn.classList.toggle('active', mode === 'source')
  elModeBtn.title =
    mode === 'source'
      ? '切换到所见即所得 (Ctrl+/)'
      : '切换到源码模式 (Ctrl+/)'
  // 切换后按当前模式的文本重建大纲（源码模式按纯文本里的 # 行）
  refreshOutline()
  if (findBarOpen()) computeFindMatches(0)
}

elModeBtn.addEventListener('click', () =>
  setMode(mode === 'wysiwyg' ? 'source' : 'wysiwyg'),
)

// ---------- 查找 / 替换 ----------
// 两种模式共用同一个面板：所见即所得用 ProseMirror 装饰高亮，源码模式用 CodeMirror 装饰
const findBar = $('findbar')
const findInput = $('find-input')
const findCount = $('find-count')
const replaceRow = $('find-replace-row')
const replaceInput = $('replace-input')
const btnFindCase = $('find-case')
const btnFindWord = $('find-word')
const btnFindRegex = $('find-regex')
const btnFindShowReplace = $('find-show-replace')
const btnFindPrev = $('find-prev')
const btnFindNext = $('find-next')
const btnReplaceOne = $('replace-one')
const btnReplaceAll = $('replace-all')

const findOptions = { caseSensitive: false, wholeWord: false, regex: false }
let findMatches = [] // [{from,to}]
let findActive = -1
let findRefreshTimer = null

function findBarOpen() {
  return !findBar.classList.contains('hidden')
}

function caretPos() {
  return mode === 'source'
    ? cmView.state.selection.main.head
    : editor.state.selection.from
}

// 所见即所得：按文本块拼接文字，记录每个字符对应的文档位置
// （同一段落里的加粗/斜体等会把文本拆成多个节点，这里要把它们拼回去）
function wysiwygSearchBlocks() {
  const blocks = []
  let cur = null
  editor.state.doc.descendants((node, pos) => {
    if (node.isTextblock) {
      cur = { text: '', pos: [] }
      blocks.push(cur)
      return true
    }
    if (node.isText && cur) {
      const text = node.text || ''
      cur.text += text
      for (let i = 0; i < text.length; i += 1) cur.pos.push(pos + i)
    }
    return true
  })
  return blocks
}

function buildSearchRegex(query) {
  let src = findOptions.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (findOptions.wholeWord) {
    src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`
  }
  try {
    return new RegExp(src, 'g' + (findOptions.caseSensitive ? '' : 'i') + 'u')
  } catch {
    return null
  }
}

function applyFindHighlights() {
  if (!findBarOpen()) return
  if (mode === 'source') {
    renderSourceHighlight()
    return
  }
  setSearchHighlight(editor, findMatches, findActive)
}

function updateFindUI() {
  const has = findMatches.length > 0
  findCount.classList.remove('bad')
  if (!findInput.value) findCount.textContent = '0/0'
  else if (has) findCount.textContent = `${findActive + 1}/${findMatches.length}`
  else findCount.textContent = '无结果'
  btnFindPrev.disabled = !has
  btnFindNext.disabled = !has
  btnReplaceOne.disabled = !has
  btnReplaceAll.disabled = !has
  applyFindHighlights()
}

function computeFindMatches(anchor) {
  const query = findInput.value
  findMatches = []
  findActive = -1
  if (!query) {
    updateFindUI()
    return
  }
  const re = buildSearchRegex(query)
  if (!re) {
    findCount.textContent = '正则无效'
    findCount.classList.add('bad')
    btnFindPrev.disabled = true
    btnFindNext.disabled = true
    btnReplaceOne.disabled = true
    btnReplaceAll.disabled = true
    applyFindHighlights()
    return
  }
  if (mode === 'source') {
    const text = getSourceText()
    let m
    while ((m = re.exec(text))) {
      if (!m[0].length) {
        re.lastIndex += 1
        continue
      }
      findMatches.push({ from: m.index, to: m.index + m[0].length })
    }
  } else {
    for (const block of wysiwygSearchBlocks()) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(block.text))) {
        if (!m[0].length) {
          re.lastIndex += 1
          continue
        }
        findMatches.push({
          from: block.pos[m.index],
          to: block.pos[m.index + m[0].length - 1] + 1,
        })
      }
    }
  }
  if (findMatches.length) {
    const idx = findMatches.findIndex((m) => m.from >= (anchor ?? 0))
    findActive = idx >= 0 ? idx : 0
  }
  updateFindUI()
}

function scheduleFindRefresh() {
  if (!findBarOpen()) return
  clearTimeout(findRefreshTimer)
  findRefreshTimer = setTimeout(() => {
    if (!findBarOpen()) return
    computeFindMatches(caretPos())
  }, 0)
}

// 源码模式：选中匹配处并滚到可视区约 1/3；不抢查找框焦点（否则没法继续输入）
function revealSourceRange(from, to) {
  cmView.dispatch({ selection: { anchor: from, head: to } })
  scrollSourceOffsetTo(from)
}

function scrollToActiveMatch() {
  const m = findMatches[findActive]
  if (!m) return
  if (mode === 'source') {
    revealSourceRange(m.from, m.to)
    return
  }
  // 不抢查找框焦点，也不改编辑区选区（避免气泡菜单弹出），只滚动到匹配处
  try {
    const res = editor.view.domAtPos(m.from)
    const el = res.node.nodeType === 1 ? res.node : res.node.parentElement
    el?.scrollIntoView({ block: 'center' })
  } catch {
    /* 位置可能已失效 */
  }
}

function stepFind(dir) {
  if (!findMatches.length) return
  const n = findMatches.length
  findActive = ((findActive + dir) % n + n) % n
  updateFindUI()
  scrollToActiveMatch()
}

function openFind(withReplace = false) {
  const firstOpen = !findBarOpen()
  findBar.classList.remove('hidden')
  replaceRow.classList.toggle('hidden', !withReplace)
  btnFindShowReplace.classList.toggle('active', withReplace)
  if (firstOpen) {
    // 有选中文字时把它作为查找词（和 Typora 一致）
    try {
      let selected = ''
      if (mode === 'source') {
        const sel = cmView.state.selection.main
        selected = getSourceText().slice(sel.from, sel.to)
      } else {
        const sel = editor.state.selection
        if (sel.from !== sel.to) {
          selected = editor.state.doc.textBetween(sel.from, sel.to, '\n')
        }
      }
      if (selected && selected.length <= 500 && !selected.includes('\n')) {
        findInput.value = selected
      }
    } catch {
      /* 选区不合法，忽略 */
    }
  }
  findInput.focus()
  findInput.select()
  computeFindMatches(caretPos())
}

function closeFind() {
  clearTimeout(findRefreshTimer)
  findBar.classList.add('hidden')
  findMatches = []
  findActive = -1
  if (mode === 'source') {
    renderSourceHighlight()
    cmView.focus()
  } else {
    setSearchHighlight(editor, [], -1)
    editor.commands.focus()
  }
}

function replaceOnce() {
  const m = findMatches[findActive]
  if (!m) return
  const rep = replaceInput.value
  const anchor = m.from + rep.length
  if (mode === 'source') {
    // 更新监听器会自动标脏/刷新统计与大纲
    cmView.dispatch({
      changes: { from: m.from, to: m.to, insert: rep },
      selection: { anchor },
    })
  } else {
    editor.view.dispatch(editor.state.tr.insertText(rep, m.from, m.to))
  }
  computeFindMatches(anchor)
  scrollToActiveMatch()
}

function replaceEvery() {
  if (!findMatches.length) return
  const rep = replaceInput.value
  if (mode === 'source') {
    // findMatches 本身是升序的，CM 一次性原子替换
    cmView.dispatch({
      changes: findMatches.map((m) => ({ from: m.from, to: m.to, insert: rep })),
    })
  } else {
    const tr = editor.state.tr
    for (let i = findMatches.length - 1; i >= 0; i -= 1) {
      tr.insertText(rep, findMatches[i].from, findMatches[i].to)
    }
    editor.view.dispatch(tr)
  }
  computeFindMatches(0)
}

$('btn-find').addEventListener('click', () => {
  if (findBarOpen()) closeFind()
  else openFind(false)
})
$('find-close').addEventListener('click', closeFind)
btnFindPrev.addEventListener('click', () => stepFind(-1))
btnFindNext.addEventListener('click', () => stepFind(1))
btnReplaceOne.addEventListener('click', replaceOnce)
btnReplaceAll.addEventListener('click', replaceEvery)

function toggleFindOption(key, btn) {
  findOptions[key] = !findOptions[key]
  btn.classList.toggle('active', findOptions[key])
  computeFindMatches(caretPos())
  findInput.focus()
}
btnFindCase.addEventListener('click', () => toggleFindOption('caseSensitive', btnFindCase))
btnFindWord.addEventListener('click', () => toggleFindOption('wholeWord', btnFindWord))
btnFindRegex.addEventListener('click', () => toggleFindOption('regex', btnFindRegex))

btnFindShowReplace.addEventListener('click', () => {
  const show = replaceRow.classList.contains('hidden')
  replaceRow.classList.toggle('hidden', !show)
  btnFindShowReplace.classList.toggle('active', show)
  if (show) replaceInput.focus()
  else findInput.focus()
})

findInput.addEventListener('input', () => computeFindMatches(caretPos()))
findInput.addEventListener('keydown', (e) => {
  e.stopPropagation()
  if (e.key === 'Enter') {
    e.preventDefault()
    stepFind(e.shiftKey ? -1 : 1)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeFind()
  } else if (e.ctrlKey && e.key.toLowerCase() === 'h') {
    e.preventDefault()
    replaceRow.classList.remove('hidden')
    btnFindShowReplace.classList.add('active')
    replaceInput.focus()
  }
})
replaceInput.addEventListener('keydown', (e) => {
  e.stopPropagation()
  if (e.key === 'Enter') {
    e.preventDefault()
    replaceOnce()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeFind()
  }
})

// 文档变化后刷新匹配（不抢焦点、不重排光标）
editor.on('transaction', ({ transaction }) => {
  if (transaction.docChanged) scheduleFindRefresh()
})

// 表格：标题栏插入 + 表格内右键菜单
$('tb-insert').addEventListener('click', () => {
  editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
})

// ---------- 插入链接：[链接名称](链接地址) ----------
const linkOverlay = $('link-overlay')
const linkTextInput = $('link-text')
const linkUrlInput = $('link-url')
let linkRange = null // 打开弹窗时的选区（弹窗期间编辑器会失焦）

function openLinkDialog() {
  const { from, to } = editor.state.selection
  const selected = from !== to ? editor.state.doc.textBetween(from, to, ' ') : ''
  linkRange = { from, to }
  linkTextInput.value = selected
  linkUrlInput.value = ''
  linkOverlay.classList.remove('hidden')
  // 已有选中文字时名称已填好，直接输入地址
  ;(selected ? linkUrlInput : linkTextInput).focus()
}

function closeLinkDialog() {
  linkOverlay.classList.add('hidden')
  linkTextInput.value = ''
  linkUrlInput.value = ''
  linkRange = null
}

function insertLink() {
  const url = linkUrlInput.value.trim()
  if (!url) {
    linkUrlInput.focus()
    return
  }
  // 名称为空时用地址代替
  const text = linkTextInput.value.trim() || url
  const sel = linkRange
  closeLinkDialog()
  const chain = editor.chain().focus()
  if (sel) chain.setTextSelection(sel)
  // 有选区时替换选中内容；无选区时插入到光标处
  chain
    .insertContent({
      type: 'text',
      text,
      marks: [{ type: 'link', attrs: { href: url } }],
    })
    .run()
  editor.commands.focus()
}

$('tb-link').addEventListener('click', openLinkDialog)
$('btn-link-cancel').addEventListener('click', closeLinkDialog)
$('btn-link-ok').addEventListener('click', insertLink)
for (const input of [linkTextInput, linkUrlInput]) {
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      insertLink()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeLinkDialog()
    }
  })
}
// 模态：点遮罩不关闭，Esc 关闭（避免误操作背后内容）
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !linkOverlay.classList.contains('hidden')) closeLinkDialog()
})

// 判断文档坐标 pos 是否位于表格内
function posInsideTable(pos) {
  const $pos = editor.state.doc.resolve(pos)
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === 'table') return true
  }
  return false
}

// 构建右键菜单项（光标已在表格内）
function tableMenuItems() {
  const chain = () => editor.chain().focus()
  return [
    { label: '上方插入行', run: () => chain().addRowBefore().run() },
    { label: '下方插入行', run: () => chain().addRowAfter().run() },
    { label: '删除行', run: () => chain().deleteRow().run() },
    { sep: true },
    { label: '左侧插入列', run: () => chain().addColumnBefore().run() },
    { label: '右侧插入列', run: () => chain().addColumnAfter().run() },
    { label: '删除列', run: () => chain().deleteColumn().run() },
    { sep: true },
    { label: '删除表格', danger: true, run: () => chain().deleteTable().run() },
  ]
}

// 右键菜单 DOM（懒创建）
const ctxMenu = document.createElement('div')
ctxMenu.className = 'ctx-menu hidden'
document.body.appendChild(ctxMenu)

function hideCtxMenu() {
  ctxMenu.classList.add('hidden')
}

// 通用右键菜单：items = [{label, run, danger} | {sep}]
function showMenu(x, y, items) {
  ctxMenu.innerHTML = ''
  for (const item of items) {
    if (item.sep) {
      const sep = document.createElement('div')
      sep.className = 'ctx-sep'
      ctxMenu.appendChild(sep)
      continue
    }
    const btn = document.createElement('button')
    btn.textContent = item.label
    if (item.danger) btn.classList.add('danger')
    btn.addEventListener('click', () => {
      hideCtxMenu()
      item.run()
    })
    ctxMenu.appendChild(btn)
  }
  ctxMenu.classList.remove('hidden')
  // 边界处理：不让菜单超出窗口
  const rect = ctxMenu.getBoundingClientRect()
  ctxMenu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px'
  ctxMenu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px'
}

// 从 DOM img 元素反解磁盘绝对路径；非本地图片返回 null
function imageDiskPath(img) {
  const src = img.getAttribute('src') || ''
  if (src.startsWith('/local-file?path=')) {
    try {
      return new URL(src, location.origin).searchParams.get('path')
    } catch {
      return null
    }
  }
  return null
}

function imageMenuItems(diskPath) {
  return [
    {
      label: '查看图片',
      run: () => wails()?.ViewImage(diskPath).catch((e) => alert('打开查看器失败: ' + e)),
    },
    {
      label: '打开图片所在目录',
      run: () => wails()?.RevealInExplorer(diskPath).catch((e) => alert('打开目录失败: ' + e)),
    },
  ]
}

// 右键：图片 > 表格 > 系统默认菜单
elTiptapWrap.addEventListener('contextmenu', (e) => {
  // 1) 图片上右键
  const imgEl = e.target.closest('img')
  if (imgEl) {
    const diskPath = imageDiskPath(imgEl)
    if (diskPath) {
      e.preventDefault()
      showMenu(e.clientX, e.clientY, imageMenuItems(diskPath))
      return
    }
    return // 网络图片无磁盘路径，保持系统菜单
  }
  // 2) 表格内右键
  const hit = editor.view.posAtCoords({ left: e.clientX, top: e.clientY })
  if (!hit || !posInsideTable(hit.pos)) return
  e.preventDefault()
  // 把光标移动到右键位置，使行/列命令作用于点击处的表格
  editor.chain().focus().setTextSelection(hit.pos).run()
  showMenu(e.clientX, e.clientY, tableMenuItems())
})

// 点击菜单外或按 Esc 关闭
window.addEventListener('pointerdown', (e) => {
  if (!ctxMenu.classList.contains('hidden') && !ctxMenu.contains(e.target)) {
    hideCtxMenu()
  }
})
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideCtxMenu()
})

// 右键菜单（表格/图片）滚动时关闭：fixed 定位不跟随内容滚动，滞留会错位
const hideCtxMenuOnScroll = () => hideCtxMenu()
editorScrollWrap?.addEventListener('scroll', hideCtxMenuOnScroll, { passive: true })
window.addEventListener('wheel', hideCtxMenuOnScroll, { passive: true })

// ---------- 右侧目录大纲（默认折叠） ----------
const outlinePanel = $('outline-panel')
const outlineList = $('outline-list')
let outlineOpen = false

function toggleOutline(open) {
  outlineOpen = open ?? !outlineOpen
  outlinePanel.classList.toggle('open', outlineOpen)
  $('btn-outline').classList.toggle('active', outlineOpen)
}

$('btn-outline').addEventListener('click', () => toggleOutline())
$('btn-outline-close').addEventListener('click', () => toggleOutline(false))

// 大纲：所见即所得从文档结构取，源码模式从纯文本按行取
function refreshOutline() {
  const items = mode === 'source' ? sourceOutlineItems() : docOutlineItems()
  outlineList.innerHTML = ''
  if (!items.length) {
    const empty = document.createElement('div')
    empty.className = 'outline-empty'
    empty.textContent = '暂无标题'
    outlineList.appendChild(empty)
    return
  }
  for (const it of items) {
    const btn = document.createElement('button')
    btn.className = `outline-item lv-${it.level}`
    btn.textContent = it.text || '(空标题)'
    btn.title = it.text
    btn.addEventListener('click', () => jumpToHeading(it))
    outlineList.appendChild(btn)
  }
}

function docOutlineItems() {
  const items = []
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name === 'heading') {
      items.push({ level: node.attrs.level, text: node.textContent, pos: offset })
    }
  })
  return items
}

function sourceOutlineItems() {
  const lines = getSourceText().split('\n')
  const items = []
  let offset = 0
  let inFence = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence
    } else if (!inFence) {
      const m = /^\s{0,3}(#{1,6})\s+(.+)$/.exec(line)
      if (m) items.push({ level: m[1].length, text: m[2].trim(), pos: offset })
    }
    offset += line.length + 1
  }
  return items
}

function jumpToHeading(item) {
  if (mode === 'source') {
    const pos = Math.min(item.pos, cmView.state.doc.length)
    cmView.focus()
    cmView.dispatch({ selection: { anchor: pos } })
    scrollSourceOffsetTo(pos)
    return
  }
  // 所见即所得：滚动到标题 DOM
  try {
    const res = editor.view.domAtPos(item.pos + 1)
    const el = res.node.nodeType === 1 ? res.node : res.node.parentElement
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  } catch {
    /* pos 已失效，忽略 */
  }
}

// ---------- 工作区 ----------
let workspacePath = ''
let workspaceTree = []
let activeDir = '' // 新建笔记/文件夹的目标目录
let wsFilter = '' // 左侧树的文件名筛选词（小写）
const expandedDirs = new Set()

const elWorkspacePanel = $('workspace-panel')
const elWsSearch = $('ws-search')
const elWsSearchBtn = $('ws-search-btn')
const elWsTree = $('ws-tree')
const elEditorEmpty = $('editor-empty')

// 筛选框默认收起成图标，点击图标才展开
function openWsSearch() {
  elWsSearch.classList.remove('hidden')
  elWsSearchBtn.classList.add('hidden')
  elWsSearch.focus()
}

function closeWsSearch(clear) {
  if (clear) {
    elWsSearch.value = ''
    wsFilter = ''
    renderTree()
  }
  elWsSearch.classList.add('hidden')
  elWsSearchBtn.classList.remove('hidden')
}

// 没有打开笔记时禁用编辑，并显示提示
function setEditorEnabled(on) {
  editor.setEditable(on)
  elEditorEmpty.classList.toggle('hidden', on)
}

async function chooseWorkspace() {
  const app = wails()
  if (!app) return
  try {
    const dir = await app.PickWorkspace()
    if (!dir) return
    await openWorkspacePath(dir)
  } catch (e) {
    alert('选择工作区失败：' + (e?.message || e))
  }
}

async function openWorkspacePath(dir) {
  const app = wails()
  if (!app) return
  try {
    const ws = await app.OpenWorkspace(dir)
    workspacePath = ws.path
    workspaceTree = ws.tree || []
    activeDir = ws.path
    expandedDirs.clear()
    clearNote()
    hideWelcome()
    elWorkspacePanel.classList.remove('hidden')
    closeWsSearch(true)
    refreshHeader()
    renderTree()
  } catch (e) {
    alert('打开工作区失败：' + (e?.message || e))
  }
}

async function refreshTree() {
  const app = wails()
  if (!app || !workspacePath) return
  try {
    const ws = await app.RefreshWorkspace()
    workspaceTree = ws.tree || []
    renderTree()
  } catch (e) {
    console.error(e)
  }
}

function noteLabel(name) {
  return name.replace(/\.(md|markdown)$/i, '')
}

const FILE_ICON =
  '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'
const FOLDER_ICON =
  '<svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'

function renderTree() {
  elWsTree.innerHTML = ''
  const nodes = filterTree(workspaceTree)
  if (!nodes.length) {
    const empty = document.createElement('div')
    empty.className = 'ws-empty'
    empty.textContent = wsFilter ? '没有匹配的笔记' : '这里还没有笔记，点右上角 ＋ 新建一篇'
    elWsTree.appendChild(empty)
    return
  }
  const frag = document.createDocumentFragment()
  for (const node of nodes) {
    for (const row of buildRows(node, 0)) frag.appendChild(row)
  }
  elWsTree.appendChild(frag)
}

// 按文件名筛选：只保留命中的笔记，以及包含命中笔记的目录（空目录隐藏）
function filterTree(nodes) {
  if (!wsFilter) return nodes
  const out = []
  for (const node of nodes) {
    if (node.isDir) {
      const children = filterTree(node.children || [])
      if (children.length) out.push({ ...node, children })
    } else if (noteLabel(node.name).toLowerCase().includes(wsFilter)) {
      out.push(node)
    }
  }
  return out
}

function buildRows(node, depth) {
  const rows = [buildRow(node, depth)]
  // 筛选时目录一律展开，方便看到命中结果
  if (node.isDir && (wsFilter || expandedDirs.has(node.path))) {
    for (const child of node.children || []) rows.push(...buildRows(child, depth + 1))
  }
  return rows
}

function buildRow(node, depth) {
  const row = document.createElement('div')
  row.className = 'ws-row' + (node.path === currentPath ? ' active' : '')
  row.style.paddingLeft = `${4 + depth * 14}px`
  row.title = node.path

  const caret = document.createElement('span')
  caret.className = 'ws-caret'
  const expanded = wsFilter ? true : expandedDirs.has(node.path)
  caret.textContent = node.isDir ? (expanded ? '▾' : '▸') : ''
  row.appendChild(caret)

  const icon = document.createElement('span')
  icon.className = 'ws-icon'
  icon.innerHTML = node.isDir ? FOLDER_ICON : FILE_ICON
  row.appendChild(icon)

  const label = document.createElement('span')
  label.className = 'ws-label'
  label.textContent = node.isDir ? node.name : noteLabel(node.name)
  row.appendChild(label)

  row.addEventListener('click', () => {
    if (node.isDir) {
      if (expandedDirs.has(node.path)) expandedDirs.delete(node.path)
      else expandedDirs.add(node.path)
      activeDir = node.path
      renderTree()
    } else {
      activeDir = dirName(node.path)
      openNote(node.path)
    }
  })

  row.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    e.stopPropagation()
    activeDir = node.isDir ? node.path : dirName(node.path)
    showMenu(e.clientX, e.clientY, entryMenuItems(node))
  })
  return row
}

function entryMenuItems(node) {
  const items = []
  if (node.isDir) {
    items.push(
      { label: '新建笔记', run: () => createNote(node.path) },
      { label: '新建文件夹', run: () => createFolder(node.path) },
      { sep: true },
    )
  } else {
    items.push({ label: '打开', run: () => openNote(node.path) }, { sep: true })
  }
  items.push(
    { label: '重命名', run: () => renameEntry(node) },
    { label: '删除', danger: true, run: () => deleteEntry(node) },
    { sep: true },
    { label: '在资源管理器中显示', run: () => wails()?.RevealInExplorer(node.path) },
  )
  return items
}

// ---------- 名称输入框（新建 / 重命名共用） ----------
const nameOverlay = $('name-overlay')
const nameInput = $('name-input')
let nameResolve = null

function askName(title, value = '', hint = '') {
  $('name-title').textContent = title
  $('name-hint').textContent = hint
  nameInput.value = value
  nameOverlay.classList.remove('hidden')
  nameInput.focus()
  nameInput.select()
  return new Promise((resolve) => {
    nameResolve = resolve
  })
}

function closeName(value) {
  nameOverlay.classList.add('hidden')
  const resolve = nameResolve
  nameResolve = null
  if (resolve) resolve(value)
}

$('name-cancel').addEventListener('click', () => closeName(null))
$('name-ok').addEventListener('click', () => closeName(nameInput.value))
nameInput.addEventListener('keydown', (e) => {
  e.stopPropagation()
  if (e.key === 'Enter') {
    e.preventDefault()
    closeName(nameInput.value)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    closeName(null)
  }
})

async function createNote(dir = activeDir) {
  const name = await askName('新建笔记', '', '名称会自动补上 .md 扩展名')
  if (name == null) return
  const app = wails()
  if (!app) return
  try {
    const path = await app.CreateNote(dir || workspacePath, name)
    expandedDirs.add(dir || workspacePath)
    await refreshTree()
    await openNote(path)
  } catch (e) {
    alert('新建笔记失败：' + (e?.message || e))
  }
}

async function createFolder(dir = activeDir) {
  const name = await askName('新建文件夹')
  if (name == null) return
  const app = wails()
  if (!app) return
  try {
    await app.CreateFolder(dir || workspacePath, name)
    expandedDirs.add(dir || workspacePath)
    await refreshTree()
  } catch (e) {
    alert('新建文件夹失败：' + (e?.message || e))
  }
}

async function renameEntry(node) {
  const name = await askName('重命名', node.name)
  if (name == null) return
  const app = wails()
  if (!app) return
  try {
    const newPath = await app.RenameEntry(node.path, name)
    await refreshTree()
    if (newPath && currentPath === node.path) {
      currentPath = newPath
      refreshHeader()
    }
  } catch (e) {
    alert('重命名失败：' + (e?.message || e))
  }
}

async function deleteEntry(node) {
  const extra = node.isDir ? '\n文件夹内的所有内容都会被删除。' : ''
  if (!confirm(`确定删除「${node.name}」吗？${extra}`)) return
  const app = wails()
  if (!app) return
  try {
    const wasOpen = currentPath === node.path || (node.isDir && currentPath.startsWith(node.path))
    await app.DeleteEntry(node.path)
    await refreshTree()
    if (wasOpen) clearNote()
  } catch (e) {
    alert('删除失败：' + (e?.message || e))
  }
}

// 打开笔记时自动展开它所在的各级目录，保证选中项在树里可见
function expandToPath(target) {
  const walk = (nodes, ancestors) => {
    for (const node of nodes) {
      if (node.path === target) {
        for (const p of ancestors) expandedDirs.add(p)
        return true
      }
      if (node.isDir && walk(node.children || [], [...ancestors, node.path])) return true
    }
    return false
  }
  walk(workspaceTree, [])
}

// ---------- 笔记打开 / 关闭 ----------
async function openNote(path) {
  const app = wails()
  if (!app) return
  if (path === currentPath) {
    editor.commands.focus()
    return
  }
  // 切换前把当前笔记的改动落盘
  if (dirty && currentPath) await saveDocument(true)
  // 源码模式先切回所见即所得，避免沿用上一篇笔记的源码文本
  if (mode === 'source') setMode('wysiwyg')
  try {
    const data = await app.OpenNote(path)
    currentPath = data.path || path
    dirty = false
    docOpen = true
    loadContent(data.content ?? '')
    setEditorEnabled(true)
    refreshHeader()
    expandToPath(currentPath)
    renderTree()
    refreshOutline()
    editor.commands.focus()
  } catch (e) {
    alert('打开笔记失败：' + (e?.message || e))
  }
}

function clearNote() {
  clearTimeout(autoSaveTimer)
  currentPath = ''
  dirty = false
  docOpen = false
  loadContent('')
  setEditorEnabled(false)
  refreshHeader()
  renderTree()
  wails()?.ClosePath()
}

$('ws-new-note').addEventListener('click', () => createNote())
$('ws-new-folder').addEventListener('click', () => createFolder())
$('ws-switch').addEventListener('click', () => chooseWorkspace())
$('btn-workspace').addEventListener('click', () => chooseWorkspace())

// 左侧树筛选：点搜索图标展开输入框，按文件名实时过滤
elWsSearchBtn.addEventListener('click', openWsSearch)
elWsSearch.addEventListener('input', () => {
  wsFilter = elWsSearch.value.trim().toLowerCase()
  renderTree()
})
elWsSearch.addEventListener('blur', () => {
  // 没有输入内容时自动收回到图标
  if (!elWsSearch.value.trim()) closeWsSearch(false)
})
elWsSearch.addEventListener('keydown', (e) => {
  e.stopPropagation()
  if (e.key === 'Escape') {
    e.preventDefault()
    closeWsSearch(true)
    elWsSearch.blur()
  }
})

// ---------- 工作区选择页 ----------
const welcomeScreen = $('welcome-screen')
const recentListEl = $('wc-recent')
const recentItemsEl = $('wc-recent-items')

function showWelcome() {
  welcomeScreen.classList.remove('hidden')
  refreshRecentWorkspaces()
}

function hideWelcome() {
  welcomeScreen.classList.add('hidden')
}

async function refreshRecentWorkspaces() {
  const app = wails()
  let list = []
  if (app) {
    try {
      list = (await app.GetSettings()).recentWorkspaces || []
    } catch {
      list = []
    }
  }
  recentItemsEl.innerHTML = ''
  if (!list.length) {
    recentListEl.classList.add('hidden')
    return
  }
  for (const p of list) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'recent-item'
    btn.title = p
    const name = document.createElement('span')
    name.className = 'recent-name'
    name.textContent = baseName(p)
    const dir = document.createElement('span')
    dir.className = 'recent-dir'
    dir.textContent = p
    btn.append(name, dir)
    btn.addEventListener('click', () => openWorkspacePath(p))
    recentItemsEl.appendChild(btn)
  }
  recentListEl.classList.remove('hidden')
}

$('wc-choose').addEventListener('click', chooseWorkspace)
// 启动页右上角：复用顶部工具栏的主题/设置逻辑
$('wc-theme').addEventListener('click', () => $('btn-theme').click())
$('wc-settings').addEventListener('click', () => openSettings())

// wails 文件拖放：只处理图片（拖入 .md 不再打开文件，文件都从左侧工作区树进入）
// 注意：wails 事件参数为 (x, y, paths)
const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']

window.runtime?.EventsOn?.('wails:file-drop', async (x, y, paths) => {
  if (!paths || !paths.length) return
  const app = wails()
  if (!app) return
  if (!currentPath) {
    alert('请先在工作区里打开一篇笔记，再插入图片')
    return
  }

  for (const p of paths) {
    const ext = (p.split('.').pop() || '').toLowerCase()
    if (imageExts.includes(ext)) {
      try {
        const res = await app.ImportImage(p)
        if (res?.src) {
          editor.chain().focus().setImage({ src: res.src }).run()
        }
      } catch (e) {
        console.error(e)
        alert('导入图片失败: ' + e)
      }
    }
  }
})

// ---------- 拖放保险层 ----------
// 阻止 WebView 默认行为（把文件当文本/链接打开）；图片拖放交给 wails 事件处理
const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files')

window.addEventListener(
  'dragover',
  (e) => {
    if (hasFiles(e)) e.preventDefault()
  },
  { capture: true },
)

window.addEventListener(
  'drop',
  (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()

    const files = [...(e.dataTransfer.items || [])]
      .filter((i) => i.kind === 'file')
      .map((i) => i.getAsFile())
      .filter(Boolean)
    if (!files.length) return

    // 直接通过 WebView2 原生桥请求 Go 解析真实路径（与 wails 的消息格式一致）
    if (window.chrome?.webview?.postMessageWithAdditionalObjects) {
      window.chrome.webview.postMessageWithAdditionalObjects(
        `file:drop:${Math.round(e.x)}:${Math.round(e.y)}`,
        files,
      )
    }
  },
  { capture: true },
)

function loadContent(md) {
  lastMarkdown = md
  rawMarkdown = md
  wysiwygEdited = false
  sourceDirty = false
  setMarkdown(editor, md)
  setSourceText(md)
  // 记录每个块在文件文本里的行，供模式切换时定位
  blockLineMap = buildBlockLineMap(md, editor.state.doc)
  refreshStats(md)
  refreshOutline()
}

function currentMarkdown() {
  return mode === 'source' ? getSourceText() : getMarkdown(editor)
}

async function saveDocument(silent = false) {
  const app = wails()
  if (!app || !currentPath) return
  try {
    const md = currentMarkdown()
    await app.SaveMarkdown(md)
    rawMarkdown = md
    if (mode === 'wysiwyg' && lastMarkdown === md) wysiwygEdited = false
    dirty = false
    refreshHeader()
  } catch (e) {
    console.error(e)
    if (!silent) alert('保存失败: ' + e)
  }
}

$('btn-save').addEventListener('click', () => saveDocument())

// 状态栏「打开所在目录」：在资源管理器中打开工作区目录
$('status-reveal').addEventListener('click', () => {
  if (!workspacePath) return
  wails()?.OpenFolder(workspacePath)
})

// ---------- 设置面板 ----------
const overlay = $('settings-overlay')
const selMode = $('set-asset-mode')
const inpFolder = $('set-assets-folder')
const inpCustomDir = $('set-custom-dir')
const rowFolder = $('row-assets-folder')
const rowCustomDir = $('row-custom-dir')

function refreshSettingsRows() {
  const custom = selMode.value === 'custom'
  rowFolder.classList.toggle('hidden', custom)
  rowCustomDir.classList.toggle('hidden', !custom)
}

// ---------- 主题 ----------
function applyTheme(theme) {
  document.body.classList.toggle('dark', theme !== 'light')
}

// 标题栏快捷切换：取当前设置覆盖 Theme 后保存
$('btn-theme').addEventListener('click', async () => {
  const app = wails()
  const next = document.body.classList.contains('dark') ? 'light' : 'dark'
  applyTheme(next)
  if (!app) return
  try {
    const s = await app.GetSettings()
    await app.SaveSettings({
      AssetMode: s.assetMode,
      AssetsFolder: s.assetsFolder,
      CustomDir: s.customDir,
      Theme: next,
    })
  } catch (e) {
    console.error(e)
  }
})

async function openSettings() {
  const app = wails()
  if (!app) return
  try {
    const s = await app.GetSettings()
    selMode.value = s.assetMode
    inpFolder.value = s.assetsFolder
    inpCustomDir.value = s.customDir || ''
    $('set-theme').value = s.theme || 'dark'
    $('set-workspace').value = s.lastWorkspace || ''
    refreshSettingsRows()
    overlay.classList.remove('hidden')
  } catch (e) {
    alert('读取设置失败: ' + e)
  }
}

async function saveSettings() {
  const app = wails()
  if (!app) return
  try {
    const theme = $('set-theme').value
    await app.SaveSettings({
      AssetMode: selMode.value,
      AssetsFolder: inpFolder.value.trim() || 'assets',
      CustomDir: inpCustomDir.value,
      Theme: theme,
    })
    applyTheme(theme) // 立即生效
    overlay.classList.add('hidden')
  } catch (e) {
    alert('保存设置失败: ' + e)
  }
}

$('btn-settings').addEventListener('click', openSettings)
$('btn-settings-ok').addEventListener('click', saveSettings)
$('btn-settings-cancel').addEventListener('click', () => overlay.classList.add('hidden'))
overlay.addEventListener('click', (e) => {
  if (e.target === overlay) overlay.classList.add('hidden')
})
selMode.addEventListener('change', refreshSettingsRows)
$('btn-choose-dir').addEventListener('click', async () => {
  const app = wails()
  if (!app) return
  const dir = await app.ChooseDirectory()
  if (dir) inpCustomDir.value = dir
})
$('btn-change-workspace').addEventListener('click', () => {
  overlay.classList.add('hidden')
  chooseWorkspace()
})

// ---------- 全局快捷键 ----------
// 有模态框打开时不响应，保证模态期间不能操作背后的编辑器
const hasOpenModal = () => !!document.querySelector('.modal-overlay:not(.hidden)')

window.addEventListener('keydown', (e) => {
  if (hasOpenModal()) return
  const mod = e.ctrlKey || e.metaKey
  if (!mod) return
  const k = e.key.toLowerCase()
  if (k === 's') {
    e.preventDefault()
    saveDocument()
  } else if (k === 'f') {
    e.preventDefault()
    openFind(false)
  } else if (k === 'h') {
    e.preventDefault()
    openFind(true)
  } else if (k === '/') {
    e.preventDefault()
    setMode(mode === 'wysiwyg' ? 'source' : 'wysiwyg')
  }
})

// ---------- 关闭流程：未保存 → 询问「保留 / 废弃」；再按设置退出或留在后台 ----------
const unsavedOverlay = $('unsaved-overlay')
let closingWithTray = true

function showUnsavedDialog() {
  $('unsaved-name').textContent = currentPath ? displayName(currentPath) : '未命名内容'
  unsavedOverlay.classList.remove('hidden')
}

// 已命名的文件本来就有自动保存，关闭时补存一次，避免 2s 防抖误报未保存
async function flushAutoSave() {
  if (!dirty) return true
  if (!currentPath) return false
  const app = wails()
  if (!app) return false
  try {
    await app.SaveMarkdown(currentMarkdown())
    dirty = false
    refreshHeader()
    return true
  } catch (e) {
    console.error('关闭前保存失败', e)
    return false
  }
}

async function onCloseRequested(hasTray) {
  closingWithTray = !!hasTray
  if (!(await flushAutoSave())) {
    showUnsavedDialog()
    return
  }
  await finishClose()
}

// 未保存内容处理完（或本来就没有）后，按设置决定退出方式
async function finishClose() {
  const app = wails()
  if (!app) return
  if (!closingWithTray) {
    app.ConfirmClose('exit', false) // 附属窗口没有托盘，直接退出
    return
  }
  let action = 'ask'
  try {
    action = (await app.GetSettings()).closeAction || 'ask'
  } catch {
    /* 读取失败按询问处理 */
  }
  if (action === 'exit') app.ConfirmClose('exit', false)
  else if (action === 'background') app.ConfirmClose('background', false)
  else showExitDialog()
}

$('btn-unsaved-cancel').addEventListener('click', () => unsavedOverlay.classList.add('hidden'))
$('btn-unsaved-discard').addEventListener('click', async () => {
  unsavedOverlay.classList.add('hidden')
  dirty = false
  refreshHeader()
  await finishClose()
})
$('btn-unsaved-save').addEventListener('click', async () => {
  const app = wails()
  if (!app) return
  try {
    if (currentPath) await app.SaveMarkdown(currentMarkdown())
    dirty = false
    refreshHeader()
  } catch (e) {
    alert('保存失败: ' + e)
    return
  }
  unsavedOverlay.classList.add('hidden')
  await finishClose()
})

// ---------- 关闭询问（退出 / 留在后台托盘） ----------
const exitOverlay = $('exit-overlay')

function showExitDialog() {
  $('exit-remember').checked = false
  exitOverlay.classList.remove('hidden')
}

$('btn-exit-cancel').addEventListener('click', () => exitOverlay.classList.add('hidden'))
$('btn-exit-quit').addEventListener('click', () => {
  exitOverlay.classList.add('hidden')
  wails()?.ConfirmClose('exit', $('exit-remember').checked)
})
$('btn-exit-background').addEventListener('click', () => {
  exitOverlay.classList.add('hidden')
  wails()?.ConfirmClose('background', $('exit-remember').checked)
})

// Go 侧关闭拦截 → 先处理未保存内容，再询问退出方式
window.runtime?.EventsOn?.('close-requested', (hasTray) => onCloseRequested(hasTray))

// 关闭到后台后再打开：回到工作区选择页
function resetToWorkspacePicker() {
  clearTimeout(autoSaveTimer)
  currentPath = ''
  dirty = false
  docOpen = false
  setMode('wysiwyg')
  loadContent('')
  workspacePath = ''
  workspaceTree = []
  expandedDirs.clear()
  elWorkspacePanel.classList.add('hidden')
  closeWsSearch(true)
  setEditorEnabled(false)
  refreshHeader()
  wails()?.ClosePath()
  showWelcome()
}

// 窗口被唤出（托盘/再次双击 exe）：
// 关闭到后台的重开 → 工作区选择页；尚未进入编辑状态 → 补显选择页
window.runtime?.EventsOn?.('window-shown', (reset) => {
  if (reset && docOpen) resetToWorkspacePicker()
  else if (!docOpen) showWelcome()
})

// ---------- 初始化 ----------
async function init() {
  const app = wails()
  // 先应用主题，避免暗色用户看到闪白
  applyTheme('dark')
  try {
    if (app) {
      const s = await app.GetSettings()
      applyTheme(s.theme)
    }
  } catch (e) {
    console.error(e)
  }
  refreshHeader()
  refreshStats(getMarkdown(editor))
  refreshOutline()
  setEditorEnabled(false)
  showWelcome()
}
init()
