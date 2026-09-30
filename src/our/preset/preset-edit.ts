/**
 * Line-level in-place editing of the preset file (agent.cordis.yml).
 *
 * Follows the "in-place modification" write principle of
 * plans/2026-08-19-上下文工程后端部分.md §1.6: read the original text → find the
 * matching plugin row → change that row's config → write back at the same
 * position; no patch-style appending and no whole-file rewrite (unless the change
 * is too large). Only the target plugin row's config subtree is touched; every
 * other byte stays as it was (comments, structure, and all other rows are left
 * alone).
 *
 * Structural convention: the top-level assembly list uses `- id: <id>` (indent
 * 0), child keys are indented +2 (name/config…), and config child keys +4. This
 * editor supports top-level plugin rows only (skill-filesystem /
 * agent-instructions / context-panel are all top-level rows).
 * @module @our/context-panel/preset-edit
 */

/** A YAML line's indent (its leading space count). */
function indentOf(line: string): number {
  let n = 0
  while (n < line.length && line[n] === ' ') n++
  return n
}

/** Whether a line is a top-level list item (`- ` at column 0). */
function isTopLevelRow(line: string): boolean {
  return /^-\s/.test(line)
}

/** Whether a line is a comment or blank. */
function isBlankOrComment(line: string): boolean {
  return line.trim().length === 0 || line.trimStart().startsWith('#')
}

/** Split lines (preserving the EOL style and a trailing newline). */
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
 * Serialize a JSON value into a YAML key block (a key line plus value lines,
 * indented by keyIndent).
 * String: multi-line → the block scalar `|-`; a single line with YAML special
 * characters → a JSON double-quoted value; otherwise a bare value.
 * An empty array/object is written explicitly as `[]`/`{}` (so it cannot be read
 * as an ambiguous null).
 * @param key - the key name.
 * @param value - a JSON-compatible value.
 * @param keyIndent - the key's indent.
 * @returns the key block's lines.
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
  // Not JSON-compatible (bigint / symbol / function): a preset file cannot hold it, write null.
  return [pad + key + ': null']
}

/** A resolved plugin row. */
interface RowLocation {
  /** Row start (0-based). */
  start: number
  /** Row indent (the leading spaces before `- id:`). */
  indent: number
  /** Row end (exclusive; the next top-level row or EOF). */
  end: number
}

/**
 * Find a top-level plugin row: by id first (`- id: <id>`), then by package name
 * (`- name: <name>`) when the id does not match.
 * @param lines - the text lines.
 * @param pluginId - the plugin id.
 * @param pluginName - the plugin package name.
 * @returns the row location, or null.
 */
export function findPluginRow(lines: string[], pluginId: string, pluginName: string): RowLocation | null {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)-\s+(id|name)\s*:\s*(['"])?([^'"]*)\3\s*$/)
    if (m === null || m[1].length !== 0) continue // top-level rows only (indent 0)
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

/** The next top-level row's index (exclusive); lines.length when there is none. */
function nextTopLevelRow(lines: string[], from: number): number {
  for (let i = from + 1; i < lines.length; i++) {
    if (isTopLevelRow(lines[i])) return i
  }
  return lines.length
}

/**
 * Find the `config:` child key inside the target row.
 * @param lines - the text lines.
 * @param row - the row location.
 * @returns the config key's index and indent; null when there is none.
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
 * Block end: from `from`, the index of the first line that is neither blank nor a
 * comment and is indented <= boundaryIndent.
 * Used to locate the end of the whole config block (where a missing key is
 * inserted).
 */
function blockEnd(lines: string[], from: number, boundaryIndent: number): number {
  for (let i = from; i < lines.length; i++) {
    if (isBlankOrComment(lines[i])) continue
    if (indentOf(lines[i]) <= boundaryIndent) return i
  }
  return lines.length
}

/**
 * Value-subtree end: from `from`, the first blank line, comment at the same or a
 * shallower indent, or line indented <= keyIndent.
 * Used to locate one key's value range, so replacing that key touches only its own
 * value and does not swallow the blank lines / comments / other keys after it.
 */
function valueBlockEnd(lines: string[], from: number, keyIndent: number): number {
  for (let i = from; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim().length === 0) return i // a blank line ends the value
    if (line.trimStart().startsWith('#')) {
      if (indentOf(line) <= keyIndent) return i // a key-level comment ends the value (and is kept)
      continue // a deeper-indented comment belongs to the value's body
    }
    if (indentOf(line) <= keyIndent) return i // a sibling key / the next row ends the value
  }
  return lines.length
}

/** Find a key inside the config block (indent == configIndent). Returns the key line's index. */
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
 * Modify a top-level plugin row's config in place: set/update the keys in
 * configPatch and leave the rest untouched.
 * @param fileText - the original text.
 * @param pluginId - the plugin id.
 * @param pluginName - the plugin package name (used when the id does not match).
 * @param configPatch - the key/values to write into config.
 * @returns the new text; null when the target row does not exist (the caller
 * decides whether to append).
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
    // config child keys are indented config.indent + 2 (config sits at indent 2, its keys at indent 4).
    const keyIndent = config.indent + 2
    // Per key: replace that key's subtree when found, otherwise insert at the end of
    // the config block (line-level boundary = config.indent).
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

  // No config child key → insert a config block at the end of the row.
  const insert: string[] = []
  if (row.start + 1 < row.end && !isBlankOrComment(next[row.end - 1])) insert.push('')
  insert.push(' '.repeat(row.indent + 2) + 'config:')
  for (const [key, value] of keys) insert.push(...serializeKeyBlock(key, value, row.indent + 4))
  next = [...next.slice(0, row.end), ...insert, ...next.slice(row.end)]
  return joinLines(next, eol, trailing)
}

/**
 * Render an assembly fragment containing a single plugin row (used when the file
 * does not exist and has to be created).
 * @param pluginId - the plugin id.
 * @param pluginName - the plugin package name.
 * @param configPatch - the config key/values.
 * @param headerComment - optional header comment lines (one element per line).
 * @returns the complete text.
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
 * Append a plugin row at the end of the file (used when the target row does not
 * exist).
 * @param fileText - the original text.
 * @param pluginId - the plugin id.
 * @param pluginName - the plugin package name.
 * @param configPatch - the config key/values.
 * @returns the new text.
 */
export function appendPluginRow(
  fileText: string,
  pluginId: string,
  pluginName: string,
  configPatch: Record<string, unknown>,
): string {
  const { lines, eol, trailing } = splitLines(fileText)
  // keep a blank line between this row and the previous one
  const insert: string[] = []
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
