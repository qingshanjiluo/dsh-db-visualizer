/**
 * Offline SQL DDL visualizer for DeepSeek Harness. Parses `CREATE TABLE`
 * statements from pasted SQL text (MySQL, PostgreSQL, and SQLite dialects)
 * and answers three questions about them: what structure they declare
 * (`db_parse_schema`), how they relate as a Mermaid `erDiagram`
 * (`db_er_mermaid`), and which schema-hygiene issues they contain
 * (`db_analyze`). The plugin never connects to a database and spawns no
 * processes — every tool is a pure text analysis.
 * @module @qingshanjiluo/dsh-db-visualizer
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-db-visualizer'
export const inject = ['tools']

/** Deployment configuration for the DDL visualizer. */
export interface Config {
  /** Whether parsed output carries `COMMENT` text declared in the DDL. */
  includeComments: boolean
  /** Name prefix used when `db_analyze` suggests new index names. */
  indexNamePrefix: string
}

/** Schemastery configuration for the DDL visualizer. */
export const Config: z<Config> = z.object({
  includeComments: z.boolean().default(true),
  indexNamePrefix: z.string().default('idx'),
})

// ---------------------------------------------------------------------------
// Internal model
// ---------------------------------------------------------------------------

interface ColInfo {
  name: string
  type: string
  nullable: boolean
  primaryKey: boolean
  unique: boolean
  hasDefault: boolean
  defaultValue: string
  comment: string
  enumValues: string[]
}

interface FkInfo {
  name: string
  columns: string[]
  refTable: string
  refColumns: string[]
  onDelete: string
  onUpdate: string
}

interface IndexInfo {
  name: string
  columns: string[]
  unique: boolean
}

interface TableInfo {
  name: string
  comment: string
  columns: ColInfo[]
  primaryKey: string[]
  indexes: IndexInfo[]
  foreignKeys: FkInfo[]
}

// ---------------------------------------------------------------------------
// Lexical helpers — string-aware scanning over raw SQL text
// ---------------------------------------------------------------------------

/**
 * Return the index just past the quoted token starting at `start`.
 * @param s - SQL text.
 * @param start - index of the opening quote (`'`, `"`, or backtick).
 * @returns End offset (exclusive).
 */
function skipQuoted(s: string, start: number): number {
  const q = s[start]!
  let i = start + 1
  while (i < s.length) {
    const ch = s[i]!
    if (ch === q) {
      if (s[i + 1] === q) {
        i += 2
        continue
      }
      return i + 1
    }
    if (ch === '\\' && q !== '`') {
      i += 2
      continue
    }
    i += 1
  }
  return s.length
}

/**
 * Remove `--`, `#`, and block comments while preserving quoted tokens.
 * @param sql - raw DDL text.
 * @returns The same text with comment spans blanked out.
 */
function stripComments(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]!
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = skipQuoted(sql, i)
      out += sql.slice(i, end)
      i = end
    } else if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1
    } else if (ch === '#') {
      while (i < sql.length && sql[i] !== '\n') i += 1
    } else if (ch === '/' && sql[i + 1] === '*') {
      const j = sql.indexOf('*/', i + 2)
      i = j < 0 ? sql.length : j + 2
    } else {
      out += ch
      i += 1
    }
  }
  return out
}

/**
 * Split on a separator that appears at paren/bracket depth zero outside strings.
 * @param s - text to split.
 * @param sep - single separator character.
 * @returns Non-empty trimmed pieces in order.
 */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  let i = 0
  while (i < s.length) {
    const ch = s[i]!
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuoted(s, i)
      continue
    }
    if (ch === '(' || ch === '[') depth += 1
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1)
    else if (ch === sep && depth === 0) {
      out.push(s.slice(start, i))
      start = i + 1
    }
    i += 1
  }
  out.push(s.slice(start))
  return out.map((piece) => piece.trim()).filter((piece) => piece.length > 0)
}

/**
 * Find the offset of the `)` closing the `(` at `open`.
 * @param s - text containing a balanced-paren region.
 * @param open - index of the opening paren.
 * @returns Closing index, or -1 when unbalanced.
 */
function findMatchingParen(s: string, open: number): number {
  let depth = 0
  let i = open
  while (i < s.length) {
    const ch = s[i]!
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuoted(s, i)
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return i
    }
    i += 1
  }
  return -1
}

/**
 * Read a possibly dotted, possibly quoted identifier starting at `from`.
 * @param s - text to scan.
 * @param from - first offset to consider.
 * @returns Last segment, all dotted segments, and the next offset; null when none.
 */
function readName(
  s: string,
  from: number,
): { name: string; parts: string[]; next: number } | null {
  const parts: string[] = []
  let i = from
  for (;;) {
    while (i < s.length && /\s/.test(s[i]!)) i += 1
    const ch = s[i]
    let seg: string
    let next: number
    if (ch === '`' || ch === '"') {
      next = skipQuoted(s, i!)
      seg = s.slice(i! + 1, Math.max(i! + 1, next - 1))
    } else if (ch === '[') {
      const end = s.indexOf(']', i!)
      if (end < 0) return parts.length > 0 ? { name: parts[parts.length - 1]!, parts, next: i } : null
      seg = s.slice(i! + 1, end)
      next = end + 1
    } else {
      const m = /^[A-Za-z_@$][\w$@]*/.exec(s.slice(i))
      if (!m) return parts.length > 0 ? { name: parts[parts.length - 1]!, parts, next: i } : null
      seg = m[0]
      next = i + m[0].length
    }
    parts.push(seg)
    i = next
    let j = i
    while (j < s.length && /\s/.test(s[j]!)) j += 1
    if (s[j] === '.') {
      i = j + 1
      continue
    }
    return { name: seg, parts, next: i }
  }
}

/**
 * Strip quoting and trailing decorations from one identifier token.
 * @param tok - raw token, e.g. `` `id` `` or `[name]` or `id DESC`.
 * @returns The bare identifier text.
 */
function bareIdent(tok: string): string {
  const t = tok.trim()
  if (t.length > 1 && ((t.startsWith('`') && t.endsWith('`')) || (t.startsWith('"') && t.endsWith('"')))) return t.slice(1, -1)
  if (t.startsWith('[') && t.endsWith(']')) return t.slice(1, -1)
  const m = /^[A-Za-z_@$][\w$@]*/.exec(t)
  return m ? m[0] : t
}

/**
 * Read the balanced `(...)` group that follows optional whitespace at `from`.
 * @param s - text containing the paren group.
 * @param from - offset to start scanning.
 * @returns Inner text plus next offset, or null when absent.
 */
function firstParen(s: string, from: number): [inner: string, next: number] | null {
  let i = from
  while (i < s.length && /\s/.test(s[i]!)) i += 1
  if (s[i] !== '(') return null
  const end = findMatchingParen(s, i)
  if (end < 0) return null
  return [s.slice(i + 1, end), end + 1]
}

/**
 * Split a column-list body into cleaned identifier names.
 * @param inner - text between parentheses.
 * @returns Identifier names with quoting, prefix lengths, and sort order removed.
 */
function splitCols(inner: string): string[] {
  return splitTopLevel(inner, ',')
    .map((tok) => bareIdent(tok.replace(/\(\s*\d+\s*\)\s*$/, '').replace(/\s+(?:ASC|DESC)$/i, '')))
    .filter((tok) => tok.length > 0)
}

/**
 * Extract quoted-or-numeric literals from a `(...)` value list.
 * @param inner - text between parentheses.
 * @returns Literal values; empty when any element is not a plain literal.
 */
function splitQuotedList(inner: string): string[] {
  const out: string[] = []
  for (const tok of splitTopLevel(inner, ',')) {
    const q = /^'((?:[^']|'')*)'$/.exec(tok)
    if (q) {
      out.push(q[1]!.replace(/''/g, "'"))
      continue
    }
    if (/^-?\d+(\.\d+)?$/.test(tok)) out.push(tok)
    else return []
  }
  return out
}

/**
 * Recognize `<col> IN ('a','b')` inside a CHECK fragment.
 * @param fragment - CHECK text.
 * @returns Column and literal set, or null when not an enum-style check.
 */
function enumFromIn(fragment: string): { col: string; values: string[] } | null {
  const m = /([A-Za-z_@$][\w$@]*)\s*(?:::\s*[A-Za-z]+)?\s*IN\s*\(([^()]*)\)/i.exec(fragment)
  if (!m) return null
  const values = splitQuotedList(m[2]!)
  return values.length > 0 ? { col: m[1]!, values } : null
}

// ---------------------------------------------------------------------------
// Statement parsing
// ---------------------------------------------------------------------------

const CONSTRAINT_RE = /^\s*CONSTRAINT\s+(`[^`]+`|"[^"]+"|\[[^\]]+\]|[A-Za-z_@$][\w$@]*)\s+/i
const REF_RE = /\bREFERENCES\b/i
const ON_DELETE_RE = /\bON\s+DELETE\s+(SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION|CASCADE|RESTRICT|\w+(?:\s+\w+)*)/i
const ON_UPDATE_RE = /\bON\s+UPDATE\s+(SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION|CASCADE|RESTRICT|\w+(?:\s+\w+)*)/i

/**
 * Parse the `REFERENCES tbl (cols) [ON ...]` clause of a foreign key.
 * @param s - text starting at or after the REFERENCES keyword.
 * @returns Reference target fields, or null when malformed.
 */
function parseRefs(s: string): Omit<FkInfo, 'name' | 'columns'> | null {
  const kw = REF_RE.exec(s)
  if (!kw) return null
  const nm = readName(s, kw.index + kw[0].length)
  if (!nm) return null
  let refColumns: string[] = []
  const p = firstParen(s, nm.next)
  if (p) refColumns = splitCols(p[0])
  const od = ON_DELETE_RE.exec(s)
  const ou = ON_UPDATE_RE.exec(s)
  return {
    refTable: nm.name,
    refColumns,
    onDelete: od ? od[1]!.toUpperCase().replace(/\s+/g, ' ') : '',
    onUpdate: ou ? ou[1]!.toUpperCase().replace(/\s+/g, ' ') : '',
  }
}

/**
 * Derive a deterministic name for an unnamed table-level index.
 * @param table - owning table.
 * @param isUnique - whether the index enforces uniqueness.
 * @param cols - indexed columns.
 * @returns An unused index name.
 */
function generateIndexName(table: TableInfo, isUnique: boolean, cols: string[]): string {
  const stem = cols.map((c) => c.replace(/[^\w]+/g, '_')).join('_') || `n${table.indexes.length + 1}`
  const base = `${isUnique ? 'uk' : 'idx'}_${table.name}_${stem}`
  let candidate = base
  let n = 2
  while (table.indexes.some((ix) => ix.name === candidate)) candidate = `${base}_${n++}`
  return candidate
}

/**
 * Parse one column definition (an item that is not a table constraint).
 * @param table - owning table, mutated.
 * @param def - the raw item text.
 * @param fallbackName - constraint name inherited from a leading CONSTRAINT clause.
 */
function parseColumn(table: TableInfo, def: string, fallbackName: string): void {
  const nm = readName(def, 0)
  if (!nm) return
  const rest = def.slice(nm.next)
  const typeM = /^\s*([A-Za-z_][A-Za-z0-9_]*)(\s*\(([^)]*)\))?(\s+(?:unsigned|signed|zerofill|varying|precision))?/i.exec(rest)
  const type = typeM
    ? (typeM[1]! + (typeM[2] ? typeM[2].replace(/\s+/g, '') : '') + (typeM[4] ? ` ${typeM[4].trim()}` : '')).toLowerCase()
    : ''
  let enumValues: string[] = []
  if (typeM && /^enum$/i.test(typeM[1]!) && typeM[3]) enumValues = splitQuotedList(typeM[3])
  const isPk = /\bPRIMARY\s+KEY\b/i.test(rest)
  const isAuto = /\bAUTO_INCREMENT\b|\bAUTOINCREMENT\b|\bGENERATED\b|\bIDENTITY\b/i.test(rest) || /(?:^|\W)(?:small|big)?serial(?:\(|\b)/i.test(type)
  const dm = /\bDEFAULT\s+('(?:[^']|'')*'|"[^"]*"|\([^()]*\)|[^\s,]+)/i.exec(rest)
  let hasDefault = isAuto
  let defaultValue = ''
  if (dm) {
    const raw = dm[1]!
    if (!/^NULL$/i.test(raw)) hasDefault = true
    defaultValue = raw
      .replace(/^\((.*)\)$/s, '$1')
      .trim()
      .replace(/^'([\s\S]*)'$/, '$1')
      .replace(/''/g, "'")
      .replace(/^"([\s\S]*)"$/, '$1')
  }
  const col: ColInfo = {
    name: nm.name,
    type,
    nullable: !isPk && !isAuto && !/\bNOT\s+NULL\b/i.test(rest),
    primaryKey: isPk,
    unique: /\bUNIQUE\b/i.test(rest),
    hasDefault,
    defaultValue,
    comment: '',
    enumValues,
  }
  const cmt = /\bCOMMENT\s*=?\s*'((?:[^']|'')*)'/i.exec(rest)
  if (cmt) col.comment = cmt[1]!.replace(/''/g, "'")
  if (/\bCHECK\b/i.test(rest) && col.enumValues.length === 0) {
    const e = enumFromIn(rest)
    if (e && e.col === col.name) col.enumValues = e.values
  }
  const ref = parseRefs(rest)
  if (ref) table.foreignKeys.push({ name: fallbackName, columns: [col.name], ...ref })
  if (col.unique) table.indexes.push({ name: fallbackName || `unique_${col.name}`, columns: [col.name], unique: true })
  table.columns.push(col)
}

/**
 * Parse one comma-separated item of a CREATE TABLE column list.
 * @param table - owning table, mutated.
 * @param item - raw item text.
 * @param errors - parse diagnostics sink.
 */
function parseTableItem(table: TableInfo, item: string, errors: string[]): void {
  let rest = item.trim()
  let cname = ''
  const cm = CONSTRAINT_RE.exec(rest)
  if (cm) {
    cname = bareIdent(cm[1]!)
    rest = rest.slice(cm[0].length).trim()
  }
  if (rest.length === 0) return
  let m: RegExpExecArray | null
  if ((m = /^PRIMARY\s+KEY\b/i.exec(rest))) {
    const cols = firstParen(rest, m.index + m[0].length)
    if (cols) table.primaryKey.push(...splitCols(cols[0]))
    return
  }
  if ((m = /^FOREIGN\s+KEY\b/i.exec(rest))) {
    const cols = firstParen(rest, m.index + m[0].length)
    const ref = cols ? parseRefs(rest.slice(cols[1])) : null
    if (!cols || !ref) {
      errors.push(`FOREIGN KEY in ${table.name} is missing a column list or REFERENCES clause`)
      return
    }
    const columns = splitCols(cols[0])
    if (columns.length === 0) return
    table.foreignKeys.push({
      name: cname || `fk_${table.name}_${columns.join('_')}`,
      columns,
      ...ref,
    })
    return
  }
  if ((m = /^(?:UNIQUE|KEY|INDEX|FULLTEXT|SPATIAL)\b/i.exec(rest))) {
    const unique = /^UNIQUE\b/i.test(rest)
    let cursor = m.index + m[0].length
    if (!/^KEY$|^INDEX$/i.test(m[0]!)) {
      const kw = /^\s*(?:KEY|INDEX)\b/i.exec(rest.slice(cursor))
      if (kw) cursor += kw[0].length
    }
    let cols = firstParen(rest, cursor)
    let name = cname
    if (!cols) {
      const nm = readName(rest, cursor)
      if (nm) {
        name = nm.name
        cols = firstParen(rest, nm.next)
      }
    }
    if (!cols) return
    const columns = splitCols(cols[0])
    if (columns.length === 0) return
    table.indexes.push({ name: name || generateIndexName(table, unique, columns), columns, unique })
    return
  }
  if (/^CHECK\b/i.test(rest)) {
    const e = enumFromIn(rest)
    if (e) {
      const col = table.columns.find((c) => c.name === e.col)
      if (col && col.enumValues.length === 0) col.enumValues = e.values
    }
    return
  }
  parseColumn(table, rest, cname)
}

/**
 * Parse every CREATE TABLE statement in a DDL script.
 * @param ddlText - raw SQL text.
 * @returns Tables in declaration order plus structural diagnostics.
 */
function parseSchema(ddlText: string): { tables: TableInfo[]; errors: string[] } {
  const errors: string[] = []
  const tables: TableInfo[] = []
  const sql = stripComments(ddlText)
  for (const stmt of splitTopLevel(sql, ';')) {
    const m = /^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i.exec(stmt)
    if (!m) continue
    const nm = readName(stmt, m[0].length)
    if (!nm) {
      errors.push('CREATE TABLE is missing a table name')
      continue
    }
    if (/^\s*(?:AS|LIKE)\b/i.test(stmt.slice(nm.next))) continue
    const open = stmt.indexOf('(', nm.next)
    if (open < 0) {
      errors.push(`CREATE TABLE ${nm.name} has no column list`)
      continue
    }
    const close = findMatchingParen(stmt, open)
    if (close < 0) {
      errors.push(`CREATE TABLE ${nm.name} has unbalanced parentheses`)
      continue
    }
    const table: TableInfo = { name: nm.name, comment: '', columns: [], primaryKey: [], indexes: [], foreignKeys: [] }
    const tc = /\bCOMMENT\s*=?\s*'((?:[^']|'')*)'/i.exec(stmt.slice(close + 1))
    if (tc) table.comment = tc[1]!.replace(/''/g, "'")
    for (const item of splitTopLevel(stmt.slice(open + 1, close), ',')) parseTableItem(table, item, errors)
    if (table.primaryKey.length === 0) table.primaryKey = table.columns.filter((c) => c.primaryKey).map((c) => c.name)
    const pkSet = new Set(table.primaryKey)
    for (const c of table.columns) if (pkSet.has(c.name)) c.primaryKey = true
    for (const ix of table.indexes) {
      if (!ix.unique || ix.columns.length !== 1) continue
      const col = table.columns.find((c) => c.name === ix.columns[0])
      if (col) col.unique = true
    }
    if (table.columns.length === 0) errors.push(`CREATE TABLE ${table.name} declares no columns`)
    tables.push(table)
  }
  for (const m of sql.matchAll(/\bCOMMENT\s+ON\s+TABLE\s+/gi)) {
    const nm = readName(sql, m.index + m[0].length)
    if (!nm) continue
    const lit = /^\s+IS\s+(?:'((?:[^']|'')*)'|NULL)/i.exec(sql.slice(nm.next))
    if (!lit) continue
    const t = tables.find((x) => x.name === nm.name)
    if (t) t.comment = lit[1] === undefined ? '' : lit[1].replace(/''/g, "'")
  }
  for (const m of sql.matchAll(/\bCOMMENT\s+ON\s+COLUMN\s+/gi)) {
    const nm = readName(sql, m.index + m[0].length)
    if (!nm || nm.parts.length < 2) continue
    const lit = /^\s+IS\s+(?:'((?:[^']|'')*)'|NULL)/i.exec(sql.slice(nm.next))
    if (!lit) continue
    const t = tables.find((x) => x.name === nm.parts[nm.parts.length - 2])
    const c = t?.columns.find((cc) => cc.name === nm.name)
    if (c) c.comment = lit[1] === undefined ? '' : lit[1].replace(/''/g, "'")
  }
  return { tables, errors }
}

// ---------------------------------------------------------------------------
// Wire projection (matches the tools' declared output schemas exactly)
// ---------------------------------------------------------------------------

/**
 * Convert parsed tables into fully-populated wire records.
 * @param tables - parsed tables.
 * @param includeComments - whether to expose COMMENT text.
 * @returns Plain JSON records matching the output schema.
 */
function wireTables(tables: TableInfo[], includeComments: boolean) {
  return tables.map((t) => ({
    name: t.name,
    comment: includeComments ? t.comment : '',
    columnCount: t.columns.length,
    primaryKey: [...t.primaryKey],
    columns: t.columns.map((c) => ({
      name: c.name,
      type: c.type,
      nullable: c.nullable,
      primaryKey: c.primaryKey,
      unique: c.unique,
      hasDefault: c.hasDefault,
      defaultValue: c.defaultValue,
      comment: includeComments ? c.comment : '',
      enumValues: [...c.enumValues],
    })),
    indexes: t.indexes.map((ix) => ({ name: ix.name, columns: [...ix.columns], unique: ix.unique })),
    foreignKeys: t.foreignKeys.map((fk) => ({
      name: fk.name,
      columns: [...fk.columns],
      referencedTable: fk.refTable,
      referencedColumns: [...fk.refColumns],
      onDelete: fk.onDelete,
      onUpdate: fk.onUpdate,
    })),
  }))
}

// ---------------------------------------------------------------------------
// Mermaid ER rendering
// ---------------------------------------------------------------------------

/**
 * Sanitize a SQL type for Mermaid attribute syntax.
 * @param type - parsed type text.
 * @returns Identifier-safe type name.
 */
function mermaidType(type: string): string {
  return type.trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_]/g, '') || 'text'
}

/**
 * Sanitize an identifier for Mermaid entity syntax.
 * @param id - table or column name.
 * @returns The name, or its punctuation-stripped form when unsafe.
 */
function mermaidIdent(id: string): string {
  return /^[A-Za-z0-9_]+$/.test(id) ? id : id.replace(/[^\w]+/g, '_')
}

/**
 * Build a Mermaid `erDiagram` source from parsed tables.
 * @param tables - parsed tables.
 * @returns The diagram text and its relation count.
 */
function buildMermaid(tables: TableInfo[]): { mermaid: string; relationCount: number } {
  const lines: string[] = ['erDiagram']
  for (const t of tables) {
    lines.push(`  ${mermaidIdent(t.name)} {`)
    for (const c of t.columns) {
      const keys: string[] = []
      if (c.primaryKey) keys.push('PK')
      if (t.foreignKeys.some((fk) => fk.columns.includes(c.name))) keys.push('FK')
      if (c.unique && !c.primaryKey) keys.push('UK')
      lines.push(`    ${mermaidType(c.type)} ${mermaidIdent(c.name)}${keys.length > 0 ? ` ${keys.join(', ')}` : ''}`)
    }
    lines.push('  }')
  }
  const relations = new Set<string>()
  for (const t of tables) {
    for (const fk of t.foreignKeys) {
      const notNull =
        fk.columns.length > 0 &&
        fk.columns.every((name) => {
          const col = t.columns.find((c) => c.name === name)
          return col ? !col.nullable : false
        })
      const oneToOne =
        notNull &&
        t.indexes.some(
          (ix) => ix.unique && ix.columns.length === fk.columns.length && ix.columns.every((c) => fk.columns.includes(c)),
        )
      const cardinality = oneToOne ? '||--||' : notNull ? '||--o{' : '|o--o{'
      const label = fk.columns.join(', ') || fk.name || 'references'
      relations.add(`${mermaidIdent(fk.refTable)} ${cardinality} ${mermaidIdent(t.name)} : "${label}"`)
    }
  }
  for (const rel of relations) lines.push(`  ${rel}`)
  return { mermaid: lines.join('\n'), relationCount: relations.size }
}

// ---------------------------------------------------------------------------
// Schema analysis
// ---------------------------------------------------------------------------

interface Finding {
  severity: 'warning' | 'info'
  rule: string
  table: string
  column: string
  message: string
}

/**
 * Whether an index column list left-prefix-covers the FK columns.
 * @param lists - candidate indexed column lists on the table.
 * @param cols - foreign key columns in order.
 * @returns True when at least one list starts with every FK column.
 */
function isCovered(lists: string[][], cols: string[]): boolean {
  return lists.some((list) => cols.every((c, i) => list[i] === c))
}

/**
 * Produce schema-hygiene findings for parsed tables.
 * @param tables - parsed tables.
 * @param indexNamePrefix - prefix for suggested index names.
 * @returns Findings grouped by table, in declaration order.
 */
function analyzeSchema(tables: TableInfo[], indexNamePrefix: string): Finding[] {
  const findings: Finding[] = []
  const known = new Set(tables.map((t) => t.name.toLowerCase()))
  const push = (severity: 'warning' | 'info', rule: string, table: string, column: string, message: string): void => {
    findings.push({ severity, rule, table, column, message })
  }
  for (const t of tables) {
    if (t.primaryKey.length === 0) {
      push('warning', 'missing-primary-key', t.name, '', 'No PRIMARY KEY declared — add one so rows are individually addressable.')
    }
    const lists = [t.primaryKey, ...t.indexes.map((ix) => ix.columns)]
    const colMap = new Map(t.columns.map((c) => [c.name, c]))
    for (const fk of t.foreignKeys) {
      if (!known.has(fk.refTable.toLowerCase())) {
        push('warning', 'dangling-fk', t.name, fk.columns.join(', '), `REFERENCES \`${fk.refTable}\`, which this DDL never creates.`)
      }
      if (!isCovered(lists, fk.columns)) {
        const stem = fk.columns.join('_')
        push(
          'warning',
          'missing-index',
          t.name,
          fk.columns.join(', '),
          `Foreign key (${fk.columns.join(', ')}) has no supporting index; joins and cascades will scan. Suggested: CREATE INDEX ${indexNamePrefix}_${t.name}_${stem} ON ${t.name} (${fk.columns.join(', ')});`,
        )
      }
      for (const c of fk.columns) {
        if (colMap.get(c)?.nullable) {
          push('info', 'nullable-fk-column', t.name, c, 'Nullable foreign key models an optional relationship — confirm that is intentional.')
        }
      }
    }
    for (const ix of t.indexes) {
      if (!ix.unique) continue
      for (const c of ix.columns) {
        if (colMap.get(c)?.nullable) {
          push('info', 'nullable-unique-column', t.name, c, 'NULL values skip UNIQUE comparison, so "unique" rows can repeat.')
        }
      }
    }
    for (const c of t.columns) {
      if (c.nullable && !c.primaryKey && !c.hasDefault) {
        push('info', 'nullable-without-default', t.name, c.name, 'Nullable without DEFAULT: every INSERT must supply it or reads see NULL — consider NOT NULL with a default.')
      }
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// Shared output schema fragments
// ---------------------------------------------------------------------------

const columnSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true, description: 'Column name.' },
    type: { type: 'string', required: true, description: 'SQL type text as parsed, e.g. varchar(255) or int unsigned.' },
    nullable: { type: 'boolean', required: true, description: 'Whether the column accepts NULL.' },
    primaryKey: { type: 'boolean', required: true, description: 'Whether the column is part of the primary key.' },
    unique: { type: 'boolean', required: true, description: 'Whether a UNIQUE constraint covers exactly this column.' },
    hasDefault: { type: 'boolean', required: true, description: 'Whether a non-NULL DEFAULT (or auto-generation) is declared.' },
    defaultValue: { type: 'string', required: true, description: 'Declared DEFAULT text; empty when absent.' },
    comment: { type: 'string', required: true, description: 'COMMENT text when declared and enabled; empty otherwise.' },
    enumValues: { type: 'array', required: true, items: { type: 'string' }, description: 'Allowed literals from ENUM or CHECK ... IN; empty when none.' },
  },
} as const

const indexSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true, description: 'Index name, synthesized when the DDL omitted one.' },
    columns: { type: 'array', required: true, items: { type: 'string' }, description: 'Indexed columns in order.' },
    unique: { type: 'boolean', required: true, description: 'Whether the index enforces uniqueness.' },
  },
} as const

const foreignKeySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true, description: 'Constraint name, synthesized when omitted; empty for inline column REFERENCES without a name.' },
    columns: { type: 'array', required: true, items: { type: 'string' }, description: 'Referencing columns in order.' },
    referencedTable: { type: 'string', required: true, description: 'Target table of REFERENCES.' },
    referencedColumns: { type: 'array', required: true, items: { type: 'string' }, description: 'Target columns; empty when the DDL omitted them.' },
    onDelete: { type: 'string', required: true, description: 'ON DELETE rule, uppercased; empty when unspecified.' },
    onUpdate: { type: 'string', required: true, description: 'ON UPDATE rule, uppercased; empty when unspecified.' },
  },
} as const

const tableSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true, description: 'Table name (schema qualification stripped).' },
    comment: { type: 'string', required: true, description: 'Table-level COMMENT text; empty when absent.' },
    columnCount: { type: 'integer', required: true, description: 'Number of parsed columns.' },
    primaryKey: { type: 'array', required: true, items: { type: 'string' }, description: 'Primary key columns in declaration order.' },
    columns: { type: 'array', required: true, items: columnSchema, description: 'Column records in declaration order.' },
    indexes: { type: 'array', required: true, items: indexSchema, description: 'Table-level and inline UNIQUE indexes.' },
    foreignKeys: { type: 'array', required: true, items: foreignKeySchema, description: 'Foreign keys declared by this table.' },
  },
} as const

// ---------------------------------------------------------------------------
// Plugin activation
// ---------------------------------------------------------------------------

/**
 * Register the DDL visualizer tools on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment's explicit visualizer policy.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'db_parse_schema',
    description:
      'Parse SQL DDL text (CREATE TABLE statements from MySQL, PostgreSQL, or SQLite dumps) and return every table ' +
      'with its columns, primary key, indexes, and foreign keys. Offline: paste the DDL directly into ddlText; no ' +
      'database connection is attempted.',
    parameters: {
      ddlText: { type: 'string', required: true, description: 'Raw SQL DDL script containing CREATE TABLE statements.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'Whether the DDL parsed without structural errors.' },
          tableCount: { type: 'integer', required: true, description: 'Number of tables parsed.' },
          errors: { type: 'array', required: true, items: { type: 'string' }, description: 'Structural parse diagnostics; empty when clean.' },
          tables: { type: 'array', required: true, items: tableSchema, description: 'Parsed table structures in declaration order.' },
        },
      },
      render: (_args, value) => {
        const rows = value.tables.map((t) => {
          const fk = t.foreignKeys.length > 0 ? `; FK ${t.foreignKeys.map((f) => `${f.columns.join('+')}->${f.referencedTable}`).join(', ')}` : ''
          return `- ${t.name} (${t.columnCount} columns; PK ${t.primaryKey.join('+') || 'none'}${fk})`
        })
        const head = value.ok
          ? `${value.tableCount} table(s) parsed.`
          : `${value.tableCount} table(s) parsed with ${value.errors.length} error(s):\n- ${value.errors.join('\n- ')}`
        return [{ type: 'text', text: [head, ...rows].join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    execute(args) {
      const { tables, errors } = parseSchema(args.ddlText)
      return Promise.resolve({
        ok: errors.length === 0,
        tableCount: tables.length,
        errors,
        tables: wireTables(tables, config.includeComments),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'db_er_mermaid',
    description:
      'Convert SQL DDL text into a Mermaid erDiagram source string showing entities with typed attributes (PK/FK/UK ' +
      'keys) and relationship lines derived from foreign keys. Offline — paste the DDL; nothing connects to a ' +
      'database. Feed the result into Mermaid to render the diagram.',
    parameters: {
      ddlText: { type: 'string', required: true, description: 'Raw SQL DDL script containing CREATE TABLE statements.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'Whether the DDL parsed without structural errors.' },
          tableCount: { type: 'integer', required: true, description: 'Number of entities drawn.' },
          relationCount: { type: 'integer', required: true, description: 'Number of relationship lines drawn.' },
          mermaid: { type: 'string', required: true, description: 'Mermaid source starting with the erDiagram keyword.' },
          errors: { type: 'array', required: true, items: { type: 'string' }, description: 'Structural parse diagnostics; empty when clean.' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.errors.length === 0
            ? value.mermaid
            : `${value.mermaid}\n%% parse errors: ${value.errors.join('; ')}`,
        },
      ],
    },
    isConcurrencySafe: () => true,
    execute(args) {
      const { tables, errors } = parseSchema(args.ddlText)
      const { mermaid, relationCount } = buildMermaid(tables)
      return Promise.resolve({ ok: errors.length === 0, tableCount: tables.length, relationCount, mermaid, errors })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'db_analyze',
    description:
      'Audit SQL DDL text for schema-hygiene issues: missing or unindexed foreign keys, tables without a primary ' +
      'key, nullable foreign keys, nullable UNIQUE columns, nullable columns without defaults, and references to ' +
      'tables the DDL never creates. Offline — paste the DDL into ddlText.',
    parameters: {
      ddlText: { type: 'string', required: true, description: 'Raw SQL DDL script containing CREATE TABLE statements.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true, description: 'Whether the DDL parsed without structural errors (findings may still exist).' },
          totalFindings: { type: 'integer', required: true, description: 'Number of findings reported.' },
          findings: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                severity: { type: 'string', required: true, enum: ['warning', 'info'], description: 'warning for likely defects, info for design advisories.' },
                rule: { type: 'string', required: true, description: 'Stable rule id, e.g. missing-index.' },
                table: { type: 'string', required: true, description: 'Table the finding applies to.' },
                column: { type: 'string', required: true, description: 'Comma-joined columns involved; empty for table-level findings.' },
                message: { type: 'string', required: true, description: 'Human-readable explanation and suggestion.' },
              },
            },
            description: 'Findings grouped by table, in declaration order.',
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.findings.length === 0
            ? `No schema findings across the DDL (${value.ok ? 'parsed cleanly' : 'with parse errors'}).`
            : `${value.totalFindings} finding(s):\n- ${value.findings.map((f) => `[${f.severity}] ${f.rule} ${f.table}${f.column ? `(${f.column})` : ''}: ${f.message}`).join('\n- ')}`,
        },
      ],
    },
    isConcurrencySafe: () => true,
    execute(args) {
      const { tables, errors } = parseSchema(args.ddlText)
      const findings = analyzeSchema(tables, config.indexNamePrefix)
      return Promise.resolve({ ok: errors.length === 0, totalFindings: findings.length, findings })
    },
  }))
}

