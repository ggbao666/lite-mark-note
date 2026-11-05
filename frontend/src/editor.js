import { Editor, Extension, getMarkRange } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { DOMParser as PMDOMParser } from '@tiptap/pm/model'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import StarterKit from '@tiptap/starter-kit'
import Bold from '@tiptap/extension-bold'
import Italic from '@tiptap/extension-italic'
import Strike from '@tiptap/extension-strike'
import Code from '@tiptap/extension-code'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { createLowlight, common } from 'lowlight'
import { Markdown } from 'tiptap-markdown'

const lowlight = createLowlight(common)

// 本地图片显示地址转换：markdown 里的相对/绝对路径 → /local-file 预览地址
function toDisplaySrc(src, getCurrentDir) {
  if (!src) return src
  if (/^(https?:|data:|blob:)/i.test(src)) return src
  // Windows 盘符绝对路径 / UNC
  if (/^[a-zA-Z]:[\\/]/.test(src) || src.startsWith('//')) {
    return '/local-file?path=' + encodeURIComponent(src)
  }
  if (src.startsWith('/')) return src // 应用内资源路径，原样
  // 相对路径 → 相对当前文件所在目录
  const dir = (getCurrentDir?.() || '').replace(/[\\/]+$/, '')
  const abs = dir ? dir + '/' + src : src
  return '/local-file?path=' + encodeURIComponent(abs)
}

// 从剪贴板/拖拽携带的 HTML 中提取网络图片地址（转存用）
function extractRemoteImageUrls(html) {
  if (!html) return []
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const urls = []
  for (const img of doc.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src') || ''
    if (/^https?:\/\//i.test(src)) urls.push(src)
  }
  return [...new Set(urls)]
}

// ---------- Markdown 原文展开 / 收回 ----------
// 文档里存的是渲染后的结构（加粗是 mark）；光标靠近某段格式时，把它就地展开成
// 真实的 Markdown 字符（** / * / ~~ / ` / [名称](地址)），光标可以停在任意字符之间
// （包括收尾标记后面），和 Typora 一样；光标离开后再收回成格式。

const MARK_TOKENS = {
  bold: '**',
  italic: '*',
  strike: '~~',
  code: '`',
}

// 链接、行内代码、删除线、加粗+斜体、加粗、斜体（先后顺序即匹配优先级）
const LITERAL_RE =
  /\[([^\[\]]+)\]\(([^()]+)\)|`([^`\n]+)`|~~([^~\n]+)~~|\*\*\*([^*\n]+)\*\*\*|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g

// 刚转换过的原文，短时间内再出现（通常是撤销）就跳过转换
let lastConverted = { literal: '', at: 0 }
// 原文是否合法的缓存：避免每次装饰/光标移动都重新解析
const literalValidCache = new Map()

function markConverted(literal) {
  lastConverted = { literal, at: Date.now() }
}

function isJustUndone(literal) {
  if (lastConverted.literal === literal && Date.now() - lastConverted.at < 3000) {
    lastConverted = { literal: '', at: 0 }
    return true
  }
  return false
}

// 找出文档里所有完整的 Markdown 原文片段（跳过代码块和已有格式的文本）
// validate=true 时只保留 Markdown 语法合法的片段（和 Typora 一致：
// 例如 * 强调 * 这种标记内侧有空格的写法 Typora 不会渲染，
// 我们也不能半渲染，否则光标移动/点击内部格式时样式会突然变化）。
function findLiterals(doc, editor, validate = true) {
  const found = []
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    if (node.marks.length) return
    if (doc.resolve(pos).parent.type.name === 'codeBlock') return
    const re = new RegExp(LITERAL_RE.source, 'g')
    let m
    while ((m = re.exec(node.text))) {
      let kind = 'italic'
      let label = m[7]
      let href = ''
      if (m[1] !== undefined) {
        kind = 'link'
        label = m[1]
        href = (m[2] || '').trim()
        if (!href) continue
      } else if (m[3] !== undefined) {
        kind = 'code'
        label = m[3]
      } else if (m[4] !== undefined) {
        kind = 'strike'
        label = m[4]
      } else if (m[5] !== undefined) {
        kind = 'bolditalic'
        label = m[5]
      } else if (m[6] !== undefined) {
        kind = 'bold'
        label = m[6]
      }
      found.push({
        start: pos + m.index,
        end: pos + m.index + m[0].length,
        kind,
        label,
        href,
        literal: m[0],
      })
    }
  })
  const items = validate && editor ? found.filter((it) => isValidLiteral(editor, it)) : found
  // 去掉相互重叠的匹配（例如行内代码里的 **）
  items.sort((a, b) => a.start - b.start)
  const result = []
  for (const item of items) {
    if (result.length && item.start < result[result.length - 1].end) continue
    result.push(item)
  }
  return result
}

// 光标是否紧贴这段原文（内部 / 开头 / 结尾）
function isNearLiteral(sel, item) {
  if (!sel.empty) return sel.from < item.end && sel.to > item.start
  return sel.from >= item.start && sel.from <= item.end
}

// 可展开的格式（含链接）；展开时按这里的顺序套标记，从外到内
const EXPAND_MARKS = ['link', 'bold', 'italic', 'strike', 'code']

// 光标紧贴格式（开头 / 内部 / 结尾）时返回要展开的范围；多个重叠格式取并集
function activeMarkAtCaret(state) {
  const sel = state.selection
  if (!sel.empty) return null
  const pos = sel.from
  const size = state.doc.content.size
  const probe = (p) => {
    if (p < 0 || p > size) return null
    const $p = state.doc.resolve(p)
    const marks = [...($p.nodeAfter?.marks || []), ...($p.nodeBefore?.marks || [])]
    const names = [...new Set(marks.map((m) => m.type.name).filter((n) => EXPAND_MARKS.includes(n)))]
    if (!names.length) return null
    const ranges = names
      .map((name) => {
        const mt = state.schema.marks[name]
        return mt ? getMarkRange($p, mt) : null
      })
      .filter(Boolean)
      .sort((a, b) => a.from - b.from)
    if (!ranges.length) return null
    let from = ranges[0].from
    let to = ranges[0].to
    for (const r of ranges.slice(1)) {
      if (r.from <= to) to = Math.max(to, r.to)
    }
    if (pos < from || pos > to) return null
    return { from, to }
  }
  return probe(pos) || (pos > 0 ? probe(pos - 1) : null) || (pos < size ? probe(pos + 1) : null)
}

// 按 Markdown 语法顺序取一段文本的格式（link 在最外层）
function marksOf(node) {
  const marks = []
  for (const name of EXPAND_MARKS) {
    const mark = node.marks.find((m) => m.type.name === name)
    if (mark) marks.push(mark)
  }
  return marks
}

// 同一格式类型 + 同一属性视为相同（链接地址不同时需要拆开重写）
function markKey(mark) {
  return mark.type.name + '|' + (mark.attrs?.href || '')
}

// 把范围内的内容组装成 Markdown 原文。
// 采用“逐段增量”生成：只在格式发生变化的位置补开/闭标记，
// 这样不同范围的嵌套（如 **加粗里有 `代码`**）不会被拆成重复的 **。
function buildInlineSource(state, from, to, caret) {
  let literal = ''
  const segments = []
  let prev = []
  const tokenOf = (mark, open) => {
    if (mark.type.name === 'link') return open ? '[' : `](${mark.attrs.href || ''})`
    return MARK_TOKENS[mark.type.name]
  }
  // 先关闭不再包含的格式（内层先关），再打开新增的格式（外层先开）
  const step = (cur) => {
    const prevKeys = prev.map(markKey)
    const curKeys = cur.map(markKey)
    const closes = prev.filter((m) => !curKeys.includes(markKey(m)))
    for (let i = closes.length - 1; i >= 0; i -= 1) literal += tokenOf(closes[i], false)
    for (const m of cur) {
      if (!prevKeys.includes(markKey(m))) literal += tokenOf(m, true)
    }
    prev = cur
  }
  state.doc.nodesBetween(from, to, (node, nodePos) => {
    if (!node.isText || !node.text) return
    const start = Math.max(from, nodePos)
    const end = Math.min(to, nodePos + node.nodeSize)
    if (start >= end) return
    const text = node.text.slice(start - nodePos, end - nodePos)
    step(marksOf(node))
    const contentStart = literal.length
    literal += text
    segments.push({ docFrom: start, docTo: end, litFrom: contentStart, litTo: contentStart + text.length })
  })
  if (!literal) return null
  for (let i = prev.length - 1; i >= 0; i -= 1) literal += tokenOf(prev[i], false)
  let pos
  if (caret <= from) pos = from
  else if (caret >= to) pos = from + literal.length
  else {
    const seg = segments.find((s) => caret >= s.docFrom && caret <= s.docTo) || segments[segments.length - 1]
    pos = from + seg.litFrom + (caret - seg.docFrom)
  }
  return { literal, pos }
}

// 格式 → 原文；光标停在任何位置都能编辑（和 Typora 一样）
// 注意：appendTransaction 返回事务后，本插件不会在同一轮里再被调用，
// 所以这里要顺手把其它已展开的原文收回，避免连续点击多个格式时旧的展开残留。
function expandMark(editor, state, info) {
  const built = buildInlineSource(state, info.from, info.to, state.selection.from)
  if (!built) return null
  const tr = state.tr.replaceWith(info.from, info.to, state.schema.text(built.literal))
  const pos = Math.min(built.pos, tr.doc.content.size)
  tr.setSelection(TextSelection.create(tr.doc, pos))
  const sel = tr.selection
  for (const item of [...findLiterals(tr.doc, editor)].reverse()) {
    if (isNearLiteral(sel, item)) continue
    if (isJustUndone(item.literal)) continue
    const node = literalFragment(editor, item) || markedTextOf(state, item)
    if (!node) continue
    tr.replaceWith(item.start, item.end, node)
    markConverted(item.literal)
  }
  tr.setMeta('addToHistory', false)
  return tr
}

// 用 Markdown 解析器把原文还原成内联片段（解析成 HTML 再用 ProseMirror 的 DOMParser 转回节点）
function parseInlineFragment(editor, text) {
  try {
    const html = editor.storage.markdown.parser.parse(text)
    const dom = document.createElement('div')
    dom.innerHTML = html
    const doc = PMDOMParser.fromSchema(editor.schema).parse(dom)
    const block = doc.firstChild
    if (!block || !block.isTextblock) return null
    return block.content
  } catch {
    return null
  }
}

// 解析结果里是否真的有对应格式；没有 → 语法不合法（Typora 同样保持普通文本）
function literalMarksOk(frag, kind) {
  let ok = false
  frag.forEach((node) => {
    if (!node.marks || !node.marks.length) return
    const names = node.marks.map((m) => m.type.name)
    const hit =
      kind === 'bolditalic'
        ? names.includes('bold') && names.includes('italic')
        : names.includes(kind)
    if (hit) ok = true
  })
  return ok
}

function isValidLiteral(editor, item) {
  const key = item.kind + '\u0000' + item.literal
  if (literalValidCache.has(key)) return literalValidCache.get(key)
  const frag = parseInlineFragment(editor, item.literal)
  const ok = !!frag && literalMarksOk(frag, item.kind)
  if (literalValidCache.size > 500) literalValidCache.clear()
  literalValidCache.set(key, ok)
  return ok
}

// 原文 → 内联片段；解析不出任何格式时返回 null，交给兜底逻辑
function literalFragment(editor, item) {
  const frag = parseInlineFragment(editor, item.literal)
  if (!frag) return null
  let hasMark = false
  frag.forEach((n) => {
    if (n.marks && n.marks.length) hasMark = true
  })
  return hasMark ? frag : null
}

// 把一段原文转成对应的格式文本节点（解析失败时的兜底）
function markedTextOf(state, item) {
  const types = item.kind === 'bolditalic' ? ['bold', 'italic'] : [item.kind]
  const marks = types
    .map((name) => {
      const mt = state.schema.marks[name]
      if (!mt) return null
      return mt.create(item.kind === 'link' ? { href: item.href } : undefined)
    })
    .filter(Boolean)
  if (!marks.length) return null
  return state.schema.text(item.label, marks)
}

// 原文 → 格式（光标紧贴这段原文时保持原文，便于修改）
function collapseLiterals(editor, state) {
  const sel = state.selection
  const found = findLiterals(state.doc, editor)
  if (!found.length) return null
  const tr = state.tr
  let changed = false
  for (const item of found.reverse()) {
    if (isNearLiteral(sel, item)) continue
    if (isJustUndone(item.literal)) continue
    const node = literalFragment(editor, item) || markedTextOf(state, item)
    if (!node) continue
    tr.replaceWith(item.start, item.end, node)
    markConverted(item.literal)
    changed = true
  }
  if (!changed) return null
  tr.setMeta('addToHistory', false)
  return tr
}

// 递归给原文加装饰：语法符号灰、内容按格式样式（支持嵌套）
function decorateLiteral(text, base, decos) {
  const re = new RegExp(LITERAL_RE.source, 'g')
  let m
  while ((m = re.exec(text))) {
    const start = base + m.index
    const raw = m[0]
    if (m[1] !== undefined) {
      const label = m[1]
      const labelStart = start + 1
      const labelEnd = labelStart + label.length
      const hrefStart = labelEnd + 2
      const hrefEnd = start + raw.length - 1
      decos.push(Decoration.inline(start, labelStart, { class: 'md-syntax' }))
      decos.push(Decoration.inline(labelStart, labelEnd, { class: 'md-link-text' }))
      decos.push(Decoration.inline(labelEnd, hrefStart, { class: 'md-syntax' }))
      decos.push(Decoration.inline(hrefStart, hrefEnd, { class: 'md-link-text' }))
      decos.push(Decoration.inline(hrefEnd, start + raw.length, { class: 'md-syntax' }))
      decorateLiteral(label, labelStart, decos)
      continue
    }
    let kind = 'italic'
    if (m[3] !== undefined) kind = 'code'
    else if (m[4] !== undefined) kind = 'strike'
    else if (m[5] !== undefined) kind = 'bolditalic'
    else if (m[6] !== undefined) kind = 'bold'
    const tokenLen = kind === 'bolditalic' ? 3 : MARK_TOKENS[kind].length
    const contentStart = start + tokenLen
    const contentEnd = start + raw.length - tokenLen
    const cls = kind === 'bolditalic' ? 'md-bold md-italic' : 'md-' + kind
    decos.push(Decoration.inline(start, contentStart, { class: 'md-syntax' }))
    decos.push(Decoration.inline(contentStart, contentEnd, { class: cls }))
    decos.push(Decoration.inline(contentEnd, start + raw.length, { class: 'md-syntax' }))
    if (kind !== 'code') {
      decorateLiteral(raw.slice(tokenLen, raw.length - tokenLen), contentStart, decos)
    }
  }
}

const MarkdownLinkAuto = Extension.create({
  name: 'markdownLinkAuto',
  addProseMirrorPlugins() {
    const enabled = () => this.editor?.canAutoConvert?.() !== false
    return [
      new Plugin({
        key: new PluginKey('markdownLinkAuto'),
        appendTransaction: (_trs, _old, newState) => {
          if (!enabled()) return null
          // 光标贴着格式 → 展开成真实 Markdown 字符（支持嵌套）
          const active = activeMarkAtCaret(newState)
          if (active) return expandMark(this.editor, newState, active)
          // 光标离开原文 → 收回成链接/加粗等格式
          return collapseLiterals(this.editor, newState)
        },
      }),
    ]
  },
})

// 原文片段着色：语法标记灰、内容按格式样式（纯装饰，不影响内容/导出）
const MarkdownSourceStyle = Extension.create({
  name: 'markdownSourceStyle',
  addProseMirrorPlugins() {
    const enabled = () => this.editor?.canAutoConvert?.() !== false
    return [
      new Plugin({
        key: new PluginKey('markdownSourceStyle'),
        props: {
          decorations(state) {
            if (!enabled()) return null
            const decos = []
            for (const item of findLiterals(state.doc, this.editor)) {
              decorateLiteral(item.literal, item.start, decos)
            }
            return decos.length ? DecorationSet.create(state.doc, decos) : null
          },
        },
      }),
    ]
  },
})

// ---------- 代码块：语法高亮 + 语言选择 + 复制 ----------
// lowlight 的常用语言集；语言值即 markdown 里 ``` 后的语言名
const CODE_LANGUAGES = [
  ['', '纯文本'],
  ['javascript', 'JavaScript'],
  ['typescript', 'TypeScript'],
  ['python', 'Python'],
  ['java', 'Java'],
  ['go', 'Go'],
  ['rust', 'Rust'],
  ['c', 'C'],
  ['cpp', 'C++'],
  ['csharp', 'C#'],
  ['html', 'HTML'],
  ['xml', 'XML'],
  ['css', 'CSS'],
  ['scss', 'SCSS'],
  ['json', 'JSON'],
  ['yaml', 'YAML'],
  ['bash', 'Bash'],
  ['shell', 'Shell'],
  ['powershell', 'PowerShell'],
  ['sql', 'SQL'],
  ['markdown', 'Markdown'],
  ['php', 'PHP'],
  ['ruby', 'Ruby'],
  ['swift', 'Swift'],
  ['kotlin', 'Kotlin'],
  ['lua', 'Lua'],
  ['r', 'R'],
  ['diff', 'Diff'],
]

// 代码块节点视图：右上角语言下拉 + 复制按钮（悬停/聚焦时出现）
const CodeBlockHighlight = CodeBlockLowlight.extend({
  addNodeView() {
    return ({ node, getPos, editor: ed }) => {
      const wrap = document.createElement('div')
      wrap.className = 'code-block'
      const bar = document.createElement('div')
      bar.className = 'code-block-bar'
      bar.contentEditable = 'false'
      const langSelect = document.createElement('select')
      langSelect.className = 'code-lang'
      langSelect.title = '代码语言'
      for (const [value, label] of CODE_LANGUAGES) {
        const opt = document.createElement('option')
        opt.value = value
        opt.textContent = label
        langSelect.appendChild(opt)
      }
      const copyBtn = document.createElement('button')
      copyBtn.type = 'button'
      copyBtn.className = 'code-copy'
      copyBtn.textContent = '复制'
      copyBtn.title = '复制代码'
      bar.append(langSelect, copyBtn)
      const pre = document.createElement('pre')
      const codeEl = document.createElement('code')
      pre.appendChild(codeEl)
      wrap.append(bar, pre)

      const applyLang = (lang) => {
        const value = lang || ''
        if (![...langSelect.options].some((o) => o.value === value)) {
          const opt = document.createElement('option')
          opt.value = value
          opt.textContent = value
          langSelect.appendChild(opt)
        }
        langSelect.value = value
        codeEl.className = value ? `language-${value}` : ''
      }
      applyLang(node.attrs.language)

      langSelect.addEventListener('change', () => {
        if (typeof getPos !== 'function') return
        const pos = getPos()
        if (pos == null) return
        const current = ed.state.doc.nodeAt(pos)
        if (!current) return
        ed.view.dispatch(
          ed.state.tr.setNodeMarkup(pos, undefined, {
            ...current.attrs,
            language: langSelect.value || null,
          }),
        )
      })

      // 复制按钮不抢编辑区焦点
      copyBtn.addEventListener('mousedown', (e) => e.preventDefault())
      copyBtn.addEventListener('click', async () => {
        let text = ''
        if (typeof getPos === 'function') {
          const pos = getPos()
          text = pos == null ? '' : ed.state.doc.nodeAt(pos)?.textContent || ''
        }
        if (!text) text = codeEl.textContent || ''
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          const ta = document.createElement('textarea')
          ta.value = text
          ta.style.position = 'fixed'
          ta.style.opacity = '0'
          document.body.appendChild(ta)
          ta.select()
          document.execCommand('copy')
          ta.remove()
        }
        copyBtn.textContent = '已复制'
        setTimeout(() => {
          copyBtn.textContent = '复制'
        }, 1200)
      })

      return {
        dom: wrap,
        contentDOM: codeEl,
        update: (updated) => {
          if (updated.type.name !== 'codeBlock') return false
          node = updated
          applyLang(updated.attrs.language)
          return true
        },
        ignoreMutation: (mutation) => {
          if (mutation.type === 'selection') return true
          return !codeEl.contains(mutation.target)
        },
      }
    }
  },
}).configure({ lowlight, defaultLanguage: null, enableTabIndentation: true })

// ---------- 查找高亮（装饰层，不影响文档内容） ----------
const searchHighlightKey = new PluginKey('searchHighlight')

const SearchHighlight = Extension.create({
  name: 'searchHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: searchHighlightKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            const meta = tr.getMeta(searchHighlightKey)
            if (!meta) return set.map(tr.mapping, tr.doc)
            const { matches = [], active = -1 } = meta
            if (!matches.length) return DecorationSet.empty
            return DecorationSet.create(
              tr.doc,
              matches.map((m, i) =>
                Decoration.inline(m.from, m.to, {
                  class: i === active ? 'find-match find-match-active' : 'find-match',
                }),
              ),
            )
          },
        },
        props: {
          decorations: (state) => searchHighlightKey.getState(state),
        },
      }),
    ]
  },
})

export function setSearchHighlight(editor, matches, active = -1) {
  editor.view.dispatch(
    editor.state.tr.setMeta(searchHighlightKey, { matches, active }),
  )
}

export function createEditor(element, { onUpdate, getCurrentDir, uploadImage, downloadImage, canAutoConvert }) {
  async function insertImageFiles(files) {
    for (const file of files) {
      try {
        const res = await uploadImage?.(file)
        if (res?.src) {
          editor.chain().focus().setImage({ src: res.src, alt: file.name }).run()
        }
      } catch (e) {
        console.error(e)
        alert('图片保存失败: ' + e)
      }
    }
  }

  // 网络图片 → Go 端下载落盘 → 插入本地引用
  async function downloadAndInsert(urls) {
    for (const url of urls) {
      try {
        const res = await downloadImage?.(url)
        if (res?.src) {
          editor.chain().focus().setImage({ src: res.src }).run()
        }
      } catch (e) {
        console.error(e)
        alert('下载图片失败: ' + e)
      }
    }
  }

  function handleImageTransfer(dataTransfer, moved) {
    if (moved) return false
    // 1) 剪贴板/拖拽自带图片文件（截图、右键复制图片）
    const files = Array.from(dataTransfer?.files || []).filter((f) =>
      f.type.startsWith('image/'),
    )
    if (files.length) {
      insertImageFiles(files)
      return true
    }
    // 2) 网页复制的图文 HTML 中携带的网络图片 → 转存到本地
    const urls = extractRemoteImageUrls(dataTransfer?.getData('text/html') || '')
    if (urls.length) {
      downloadAndInsert(urls)
      return true
    }
    return false
  }

  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        // 这些格式改用下方自定义版本：光标贴在格式末尾继续输入时不再吸进格式里
        bold: false,
        italic: false,
        strike: false,
        code: false,
        link: false,
        // 代码块改用 lowlight 版（语法高亮 + 语言选择）
        codeBlock: false,
      }),
      CodeBlockHighlight,
      SearchHighlight,
      Bold.extend({ inclusive: false }),
      Italic.extend({ inclusive: false }),
      Strike.extend({ inclusive: false }),
      // Tiptap 默认让行内代码排斥所有其他格式；但 Typora 里 **加粗里有 `代码`**
      // 的行内代码仍是加粗的一部分，收回/展开/导出都要保持嵌套
      Code.extend({ inclusive: false, excludes: '' }),
      // 编辑时点击链接不跳转，避免 WebView 离开编辑器；inclusive=false 让链接结束后打字不再进链接
      Link.extend({ inclusive: false }).configure({ openOnClick: false }),
      MarkdownLinkAuto,
      MarkdownSourceStyle,
      Image.configure({ inline: false, allowBase64: true }).extend({
        renderHTML({ node, HTMLAttributes }) {
          // attrs.src 保持 markdown 原文路径（tiptap-markdown 导出用它），
          // 仅在 DOM 渲染时转换为本地文件预览地址
          return ['img', { ...HTMLAttributes, src: toDisplaySrc(HTMLAttributes.src, getCurrentDir) }]
        },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Markdown.configure({
        html: true,
        linkify: true,
        breaks: false,
        transformPastedText: true,
        transformCopiedText: false,
      }),
    ],
    content: '', // 启动时空白；由启动页引导新建/打开/拖拽
    onUpdate: ({ editor }) => onUpdate(getMarkdown(editor)),
    editorProps: {
      handlePaste: (_view, event) => {
        const handled = handleImageTransfer(event.clipboardData, false)
        if (handled) event.preventDefault()
        return handled
      },
      handleDrop: (_view, event, _slice, moved) => {
        const handled = handleImageTransfer(event.dataTransfer, moved)
        if (handled) event.preventDefault()
        return handled
      },
    },
  })
  // 供自动转换判断当前是否处于可编辑（所见即所得）状态
  editor.canAutoConvert = canAutoConvert || (() => true)
  return editor
}

export function getMarkdown(editor) {
  const state = editor.state
  // 序列化时放宽校验：任何原文片段都要先收回成格式，避免 ** / * 等被反斜杠转义
  const literals = findLiterals(state.doc, editor, false)
  if (!literals.length) return editor.storage.markdown.getMarkdown()
  // 序列化前把展开的原文收回成格式：否则 ** 等字符会被反斜杠转义写进文件
  const tr = state.tr
  for (const item of [...literals].reverse()) {
    const node = literalFragment(editor, item) || markedTextOf(state, item)
    if (!node) continue
    tr.replaceWith(item.start, item.end, node)
  }
  return editor.storage.markdown.serializer.serialize(tr.doc)
}

// 替换内容但不触发 onUpdate（避免打开文件时误标脏状态）
export function setMarkdown(editor, md) {
  editor.commands.setContent(md, { emitUpdate: false })
}

export function countWords(text) {
  const t = text.replace(/\s+/g, '')
  return t.length
}
