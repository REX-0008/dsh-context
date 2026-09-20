/**
 * 预设文件行级原位编辑（agent.cordis.yml）。
 *
 * 对齐 plans/2026-08-19-上下文工程后端部分.md §1.6 的「原位修改」写原则：
 * 读取原文 → 找到对应插件行 → 改该行 config → 写回原位置；不补丁式追加、
 * 不整体重写（除非改动过大）。只动目标插件行的 config 子树，其余字节原样保留
 * （注释、结构、其他行全部不动）。
 *
 * 结构约定：顶层装配列表 `- id: <id>`（缩进 0），子键缩进 +2（name/config…），
 * config 子键缩进 +4。本编辑器只支持顶层插件行（skill-filesystem /
 * agent-instructions / context-panel 均为顶层行）。
 * @module @our/context-panel/preset-edit
 */

/** 一行 YAML 的缩进（前导空格数）。 */
function indentOf(line: string): number {
  let n = 0
  while (n < line.length && line[n] === ' ') n++
  return n
}

/** 判断一行是否为顶层列表项（列 0 的 `- `）。 */
function isTopLevelRow(line: string): boolean {
  return /^-\s/.test(line)
}

/** 判断一行是否为注释或空白。 */
function isBlankOrComment(line: string): boolean {
  return line.trim().length === 0 || line.trimStart().startsWith('#')
}

/** 切行（保留换行符风格与末尾换行）。 */
function splitLines(text: string): { lines: string[]; eol: string; trailing: boolean } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const raw = text.split(/\r?\n/)
  const trailing = raw.length > 0 && raw[raw.length - 1] === ''
  const lines = trailing ? raw.slice(0, -1) : raw
  return { lines, eol, trailing }
}

function joinLines(lines: string[], eol: string, trailing: boolean): string {
  const body = lines.join(eol)
  return trailing ? body + eol : body
}

/**
 * 把 JSON 值序列化为 YAML 键块（key 行 + 值行，缩进 keyIndent）。
 * 字符串：多行 → 块标量 `|-`；单行含 YAML 特殊字符 → JSON 双引号；否则裸值。
 * 空数组/空对象显式写 `[]`/`{}`（避免歧义成 null）。
 * @param key - 键名。
 * @param value - JSON 兼容值。
 * @param keyIndent - 键的缩进。
 * @returns 键块行数组。
 */
export function serializeKeyBlock(key: string, value: unknown, keyIndent: number): string[] {
  const pad = ' '.repeat(keyIndent)
  if (value === null || value === undefined) return [pad + key + ': null']
  if (typeof value === 'string') {
    if (value.includes('\n')) {
      const out = [pad + key + ': |-']
      for (const line of value.split('\n')) {
        out.push(' '.repeat(keyIndent + 2) + (line.length === 0 ? '' : line))
      }
      return out
    }
    if (/^[A-Za-z0-9_./:@\- ]*$/.test(value) && value.trim() === value && value.length > 0) {
      return [pad + key + ': ' + value]
    }
    return [pad + key + ': ' + JSON.stringify(value)]
  }
  if (typeof value === 'number' || typeof value === 'boolean') return [pad + key + ': ' + String(value)]
  if (Array.isArray(value)) {
    if (value.length === 0) return [pad + key + ': []']
    const out = [pad + key + ':']
    for (const item of value) {
      if (typeof item === 'string') out.push(' '.repeat(keyIndent + 2) + '- ' + JSON.stringify(item))
      else if (typeof item === 'object' && item !== null) out.push(' '.repeat(keyIndent + 2) + '- ' + JSON.stringify(item))
      else out.push(' '.repeat(keyIndent + 2) + '- ' + String(item))
    }
    return out
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return [pad + key + ': {}']
    const out = [pad + key + ':']
    for (const [k, v] of entries) out.push(...serializeKeyBlock(k, v, keyIndent + 2))
    return out
  }
  return [pad + key + ': ' + String(value)]
}

/** 插件行解析结果。 */
interface RowLocation {
  /** 行起点（0 基）。 */
  start: number
  /** 行缩进（`- id:` 的前导空格数）。 */
  indent: number
  /** 行终点（不含；下一个顶层行或 EOF）。 */
  end: number
}

/**
 * 查找顶层插件行：先按 id（`- id: <id>`），未命中按包名（`- name: <name>`）。
 * @param lines - 文本行。
 * @param pluginId - 插件 id。
 * @param pluginName - 插件包名。
 * @returns 行定位或 null。
 */
export function findPluginRow(lines: string[], pluginId: string, pluginName: string): RowLocation | null {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)-\s+(id|name)\s*:\s*(['"])?([^'"]*)\3\s*$/)
    if (m === null || m[1].length !== 0) continue // 只处理顶层行（缩进 0）
    const kind = m[2]
    const value = m[4]
    if (kind === 'id' && value === pluginId) {
      const end = nextTopLevelRow(lines, i)
      return { start: i, indent: 0, end }
    }
    if (kind === 'name' && value === pluginName) {
      const end = nextTopLevelRow(lines, i)
      return { start: i, indent: 0, end }
    }
  }
  return null
}

/** 下一个顶层行下标（不含）；无则 lines.length。 */
function nextTopLevelRow(lines: string[], from: number): number {
  for (let i = from + 1; i < lines.length; i++) {
    if (isTopLevelRow(lines[i])) return i
  }
  return lines.length
}

/**
 * 在目标行内查找 `config:` 子键。
 * @param lines - 文本行。
 * @param row - 行定位。
 * @returns config 键下标与缩进；无则 null。
 */
function findConfigKey(lines: string[], row: RowLocation): { index: number; indent: number } | null {
  for (let i = row.start + 1; i < row.end; i++) {
    const line = lines[i]
    const m = line.match(/^(\s*)config\s*:\s*(#.*)?$/)
    if (m !== null) {
      const indent = m[1].length
      if (indent > row.indent) return { index: i, indent }
    }
  }
  return null
}

/**
 * 块结束位：从 from 起，第一个「非空/非注释且缩进 <= boundaryIndent」的行下标。
 * 用于定位整个 config 块的结束（插入缺失键的位置）。
 */
function blockEnd(lines: string[], from: number, boundaryIndent: number): number {
  for (let i = from; i < lines.length; i++) {
    if (isBlankOrComment(lines[i])) continue
    if (indentOf(lines[i]) <= boundaryIndent) return i
  }
  return lines.length
}

/**
 * 键值子树结束位：从 from 起，第一个「空行、同级或更浅的注释、或缩进 <= keyIndent」的行。
 * 用于定位单个键的值范围（替换该键时只动它自己的值，不吞后面的空行/注释/其他键）。
 */
function valueBlockEnd(lines: string[], from: number, keyIndent: number): number {
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim().length === 0) return i // 空行结束键值
    if (line.trimStart().startsWith('#')) {
      if (indentOf(line) <= keyIndent) return i // 键级注释结束键值（保留）
      continue // 更深缩进的注释属于键值内部
    }
    if (indentOf(line) <= keyIndent) return i // 兄弟键 / 下一行结束键值
  }
  return lines.length
}

/** 在 config 块内查找指定键（缩进 == configIndent）。返回键行下标。 */
function findConfigKeyLine(lines: string[], from: number, to: number, key: string, configIndent: number): number {
  for (let i = from; i < to; i++) {
    const line = lines[i]
    if (isBlankOrComment(line)) continue
    const m = line.match(/^(\s*)([^:#]+)\s*:\s*/)
    if (m === null) continue
    if (m[1].length !== configIndent) continue
    if (m[2].trim() === key) return i
  }
  return -1
}

/**
 * 对顶层插件行的 config 做原位修改：set/更新 configPatch 中的键，其余不动。
 * @param fileText - 原文。
 * @param pluginId - 插件 id。
 * @param pluginName - 插件包名（id 未命中时按 name 找）。
 * @param configPatch - 要写入 config 的键值。
 * @returns 新文本；目标行不存在时返回 null（调用方决定追加）。
 */
export function updatePluginRowConfig(
  fileText: string,
  pluginId: string,
  pluginName: string,
  configPatch: Record<string, unknown>,
): string | null {
  const { lines, eol, trailing } = splitLines(fileText)
  const row = findPluginRow(lines, pluginId, pluginName)
  if (row === null) return null

  const keys = Object.entries(configPatch)
  if (keys.length === 0) return fileText

  let next: string[] = lines
  const config = findConfigKey(next, row)

  if (config !== null) {
    // config 子键缩进 = config.indent + 2（config 在缩进 2，其键在缩进 4）。
    const keyIndent = config.indent + 2
    // 每个键：命中则替换该键子树，未命中则插到 config 块末尾（行级边界 = config.indent）。
    for (const [key, value] of keys) {
      const keyLine = findConfigKeyLine(next, config.index + 1, row.end, key, keyIndent)
      if (keyLine >= 0) {
        const end = valueBlockEnd(next, keyLine + 1, keyIndent)
        const block = serializeKeyBlock(key, value, keyIndent)
        next = [...next.slice(0, keyLine), ...block, ...next.slice(end)]
      } else {
        const end = blockEnd(next, config.index + 1, config.indent)
        const insert = serializeKeyBlock(key, value, keyIndent)
        next = [...next.slice(0, end), ...insert, ...next.slice(end)]
      }
    }
    return joinLines(next, eol, trailing)
  }

  // 无 config 子键 → 在行末尾插入 config 块。
  const insert: string[] = []
  if (row.start + 1 < row.end && !isBlankOrComment(next[row.end - 1])) insert.push('')
  insert.push(' '.repeat(row.indent + 2) + 'config:')
  for (const [key, value] of keys) insert.push(...serializeKeyBlock(key, value, row.indent + 4))
  next = [...next.slice(0, row.end), ...insert, ...next.slice(row.end)]
  return joinLines(next, eol, trailing)
}

/**
 * 生成一个仅含单个插件行的装配片段（文件不存在时创建用）。
 * @param pluginId - 插件 id。
 * @param pluginName - 插件包名。
 * @param configPatch - config 键值。
 * @param headerComment - 可选头部注释行（每行一个元素）。
 * @returns 完整文本。
 */
export function renderPluginRow(
  pluginId: string,
  pluginName: string,
  configPatch: Record<string, unknown>,
  headerComment?: string[],
): string {
  const out: string[] = []
  if (headerComment !== undefined && headerComment.length > 0) {
    for (const line of headerComment) out.push('# ' + line)
  }
  out.push('- id: ' + pluginId)
  out.push("  name: '" + pluginName + "'")
  out.push('  config:')
  for (const [key, value] of Object.entries(configPatch)) {
    out.push(...serializeKeyBlock(key, value, 4))
  }
  return out.join('\n') + '\n'
}

/**
 * 在文件末尾追加一个插件行（目标行不存在时用）。
 * @param fileText - 原文。
 * @param pluginId - 插件 id。
 * @param pluginName - 插件包名。
 * @param configPatch - config 键值。
 * @returns 新文本。
 */
export function appendPluginRow(
  fileText: string,
  pluginId: string,
  pluginName: string,
  configPatch: Record<string, unknown>,
): string {
  const { lines, eol, trailing } = splitLines(fileText)
  // 保证与上一行之间有空白行
  let insert: string[] = []
  const last = lines.length - 1
  if (last >= 0 && !isBlankOrComment(lines[last])) insert.push('')
  insert.push('- id: ' + pluginId)
  insert.push("  name: '" + pluginName + "'")
  insert.push('  config:')
  for (const [key, value] of Object.entries(configPatch)) {
    insert.push(...serializeKeyBlock(key, value, 4))
  }
  return joinLines([...lines, ...insert], eol, trailing)
}