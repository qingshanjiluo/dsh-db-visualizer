/**
 * dsh-db-visualizer — 数据库Schema可视化
 *
 * 功能：
 * 1. 连接数据库
 * 2. 浏览Schema
 * 3. 描述表结构
 * 4. 执行查询
 * 5. 生成ER图
 * 6. 分析优化
 *
 * 工具：db_connect, db_schemas, db_describe, db_query, db_er_diagram, db_analyze
 * 命令：/db
 * 配置：enabled
 */
import { z } from 'zod'
import { execSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

export const name = 'dsh-db-visualizer'
export const inject = ['settings', 'commands']

const configSchema = z.object({
  enabled: z.boolean().default(true),
  defaultPort: z.number().default(5432),
  maxRows: z.number().default(100),
})

interface Connection {
  type: string
  host: string
  port: number
  database: string
  user: string
  password: string
}

let currentConnection: Connection | null = null

function sanitize(s: string): string {
  return s.replace(/[;&|`$(){}[\]!#~<>'"]/g, '');
}

function buildPsqlCommand(conn: Connection, sql: string): string {
  const envVars = `PGPASSWORD="${sanitize(conn.password)}"`
  return `${envVars} psql -h ${sanitize(conn.host)} -p ${conn.port} -U ${sanitize(conn.user)} -d ${sanitize(conn.database)} -t -A -c "${sanitize(sql)}"`
}

function buildMysqlCommand(conn: Connection, sql: string): string {
  return `mysql -h ${sanitize(conn.host)} -P ${conn.port} -u ${sanitize(conn.user)} -p"${sanitize(conn.password)}" ${sanitize(conn.database)} -e "${sanitize(sql)}"`
}

function executeQuery(conn: Connection, sql: string): string {
  try {
    if (conn.type === 'sqlite') {
      return execSync(`sqlite3 "${sanitize(conn.database)}" "${sanitize(sql)}"`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
    }
    if (conn.type === 'postgres') {
      return execSync(buildPsqlCommand(conn, sql), { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
    }
    if (conn.type === 'mysql') {
      return execSync(buildMysqlCommand(conn, sql), { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
    }
    throw new Error(`不支持的数据库类型: ${conn.type}`)
  } catch (err: any) {
    throw new Error(err.stderr || err.message || '查询执行失败');
  }
}

export function apply(ctx: any) {
  const config = configSchema.parse(ctx.settings.get(name) ?? {})

  ctx.tools.register('db_connect', {
    description: 'Connect to a database',
    parameters: z.object({
      type: z.enum(['postgres', 'mysql', 'sqlite']),
      host: z.string().optional().default('localhost'),
      port: z.number().optional(),
      database: z.string(),
      user: z.string().optional().default(''),
      password: z.string().optional().default(''),
    }),
    async execute(params: any) {
      const port = params.port ?? (params.type === 'sqlite' ? 0 : config.defaultPort)
      currentConnection = {
        type: params.type,
        host: params.host,
        port,
        database: params.database,
        user: params.user,
        password: params.password,
      }
      if (params.type !== 'sqlite') {
        executeQuery(currentConnection, 'SELECT 1')
      } else if (!existsSync(params.database)) {
        return { success: false, message: `SQLite file not found: ${params.database}` }
      }
      return { success: true, connection: { type: params.type, host: params.host, port, database: params.database, user: params.user } }
    },
  })

  ctx.tools.register('db_schemas', {
    description: 'List all schemas/tables in the database',
    parameters: z.object({}),
    async execute() {
      if (!currentConnection) return { success: false, message: 'No active connection' }
      const conn = currentConnection
      let sql = ''
      if (conn.type === 'postgres') {
        sql = `SELECT table_name, pg_size_pretty(pg_total_relation_size(quote_ident(table_schema)||'.'||quote_ident(table_name))) AS size FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_name`
      } else if (conn.type === 'mysql') {
        sql = `SELECT table_name, table_rows AS row_count FROM information_schema.tables WHERE table_schema='${conn.database}' ORDER BY table_name`
      } else {
        sql = `.tables`
      }
      const result = executeQuery(conn, sql)
      const tables: any[] = []
      if (conn.type === 'sqlite') {
        const tableLines = result.trim().split('\n').filter(Boolean)
        for (const t of tableLines) {
          const name = t.trim()
          if (!name) continue
          const countResult = executeQuery(conn, `SELECT COUNT(*) FROM "${name}"`).trim()
          tables.push({ name, rowCount: parseInt(countResult) || 0 })
        }
      } else {
        const lines = result.trim().split('\n').filter(Boolean)
        for (const line of lines) {
          const parts = line.split('|')
          tables.push({ name: parts[0]?.trim(), size: parts[1]?.trim() ?? '' })
        }
      }
      return { success: true, tables }
    },
  })

  ctx.tools.register('db_describe', {
    description: 'Describe a table structure',
    parameters: z.object({ table: z.string() }),
    async execute(params: any) {
      if (!currentConnection) return { success: false, message: 'No active connection' }
      const conn = currentConnection
      let sql = ''
      if (conn.type === 'postgres') {
        sql = `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default, CASE WHEN pk.column_name IS NOT NULL THEN 'PRIMARY KEY' ELSE '' END AS key_info FROM information_schema.columns c LEFT JOIN (SELECT ku.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage ku ON tc.constraint_name=ku.constraint_name WHERE tc.table_name='${params.table}' AND tc.constraint_type='PRIMARY KEY') pk ON c.column_name=pk.column_name WHERE c.table_name='${params.table}' ORDER BY c.ordinal_position`
      } else if (conn.type === 'mysql') {
        sql = `DESCRIBE \`${params.table}\``
      } else {
        sql = `PRAGMA table_info("${params.table}")`
      }
      const result = executeQuery(conn, sql)
      let indexes: any[] = []
      if (conn.type === 'postgres') {
        const idxSql = `SELECT indexname, indexdef FROM pg_indexes WHERE tablename='${params.table}'`
        indexes = executeQuery(conn, idxSql).trim().split('\n').filter(Boolean).map(line => {
          const [name, def] = line.split('|')
          return { name: name?.trim(), definition: def?.trim() }
        })
      } else if (conn.type === 'mysql') {
        const idxSql = `SHOW INDEX FROM \`${params.table}\``
        indexes = executeQuery(conn, idxSql).trim().split('\n').filter(Boolean).slice(1).map(line => {
          const parts = line.split('\t')
          return { name: parts[2]?.trim(), column: parts[4]?.trim() }
        })
      }
      return { success: true, columns: result, indexes }
    },
  })

  ctx.tools.register('db_query', {
    description: 'Execute a read-only SQL query',
    parameters: z.object({ sql: z.string() }),
    async execute(params: any) {
      if (!currentConnection) return { success: false, message: 'No active connection' }
      const trimmed = params.sql.trim().toUpperCase()
      if (!trimmed.startsWith('SELECT')) {
        return { success: false, message: 'Only SELECT queries are allowed' }
      }
      const limitedSql = params.sql.includes('LIMIT') ? params.sql : `${params.sql.replace(/;$/, '')} LIMIT ${config.maxRows}`
      const result = executeQuery(currentConnection, limitedSql)
      return { success: true, result }
    },
  })

  ctx.tools.register('db_er_diagram', {
    description: 'Generate an ER diagram in Mermaid syntax',
    parameters: z.object({}),
    async execute() {
      if (!currentConnection) return { success: false, message: 'No active connection' }
      const conn = currentConnection
      let fkSql = ''
      if (conn.type === 'postgres') {
        fkSql = `SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table, ccu.column_name AS foreign_column FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name WHERE tc.constraint_type='FOREIGN KEY'`
      } else if (conn.type === 'mysql') {
        fkSql = `SELECT table_name, column_name, referenced_table_name, referenced_column_name FROM information_schema.key_column_usage WHERE table_schema='${conn.database}' AND referenced_table_name IS NOT NULL`
      } else {
        fkSql = `SELECT name AS table_name FROM sqlite_master WHERE type='table'`
      }
      const fkResult = executeQuery(conn, fkSql)
      let tableSql = ''
      if (conn.type === 'postgres') {
        tableSql = `SELECT table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')`
      } else if (conn.type === 'mysql') {
        tableSql = `SELECT table_name FROM information_schema.tables WHERE table_schema='${conn.database}'`
      } else {
        tableSql = `.tables`
      }
      const tableResult = executeQuery(conn, tableSql)
      const tables = tableResult.trim().split('\n').filter(Boolean).map(t => t.trim())
      const mermaid: string[] = ['erDiagram']
      for (const table of tables) {
        mermaid.push(`  ${table} {`)
        if (conn.type === 'postgres') {
          const colSql = `SELECT column_name, data_type FROM information_schema.columns WHERE table_name='${table}' ORDER BY ordinal_position`
          const cols = executeQuery(conn, colSql).trim().split('\n').filter(Boolean)
          for (const col of cols) {
            const [name, type] = col.split('|')
            mermaid.push(`    ${type} ${name?.trim()}`)
          }
        }
        mermaid.push('  }')
      }
      const fkLines = fkResult.trim().split('\n').filter(Boolean)
      for (const line of fkLines) {
        const parts = line.split('|')
        const fromTable = parts[0]?.trim()
        const fkCol = parts[1]?.trim()
        const toTable = parts[2]?.trim()
        const toCol = parts[3]?.trim()
        if (fromTable && toTable) {
          mermaid.push(`  ${fromTable} ||--o{ ${toTable} : "${fkCol} -> ${toCol}"`)
        }
      }
      return { success: true, diagram: mermaid.join('\n') }
    },
  })

  ctx.tools.register('db_analyze', {
    description: 'Analyze database health and provide recommendations',
    parameters: z.object({}),
    async execute() {
      if (!currentConnection) return { success: false, message: 'No active connection' }
      const conn = currentConnection
      const analysis: any = { tables: [], indexes: [], recommendations: [] }
      let tableSql = ''
      if (conn.type === 'postgres') {
        tableSql = `SELECT schemaname, relname, n_live_tup, pg_size_pretty(pg_total_relation_size(relid)) AS size FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC`
      } else if (conn.type === 'mysql') {
        tableSql = `SELECT table_name, table_rows, ROUND(data_length/1024/1024,2) AS data_mb, ROUND(index_length/1024/1024,2) AS index_mb FROM information_schema.tables WHERE table_schema='${conn.database}' ORDER BY data_length DESC`
      }
      const tableResult = executeQuery(conn, tableSql)
      if (tableResult.trim()) {
        const lines = tableResult.trim().split('\n').filter(Boolean)
        for (const line of lines) {
          const parts = line.split('|')
          analysis.tables.push({ name: parts[1]?.trim(), rows: parts[2]?.trim(), size: parts[3]?.trim() })
        }
      }
      if (conn.type === 'postgres') {
        const idxSql = `SELECT schemaname, relname, idx_scan, idx_tup_read FROM pg_stat_user_indexes WHERE idx_scan=0 AND schemaname='public'`
        const unusedIdx = executeQuery(conn, idxSql)
        if (unusedIdx.trim()) {
          analysis.recommendations.push('Consider removing unused indexes')
        }
        const seqScanSql = `SELECT relname, seq_scan, seq_tup_read FROM pg_stat_user_tables WHERE seq_scan > 0 ORDER BY seq_tup_read DESC LIMIT 5`
        const seqResult = executeQuery(conn, seqScanSql)
        if (seqResult.trim()) {
          analysis.recommendations.push('Tables with high sequential scans may benefit from additional indexes')
        }
      }
      if (conn.type === 'mysql') {
        const idxSql = `SELECT table_name, index_name, non_unique FROM information_schema.statistics WHERE table_schema='${conn.database}' AND non_unique=0`
        const pkResult = executeQuery(conn, idxSql)
        const tablesWithPk = new Set(pkResult.trim().split('\n').filter(Boolean).map(l => l.split('\t')[0]?.trim()))
        for (const table of analysis.tables) {
          if (!tablesWithPk.has(table.name)) {
            analysis.recommendations.push(`Table '${table.name}' lacks a primary key`)
          }
        }
      }
      return { success: true, analysis }
    },
  })

  ctx.commands.register('db', {
    description: 'Database visualization commands',
    async execute(args: string[]) {
      const sub = args[0]
      if (sub === 'connect') {
        const type = args[1] || 'postgres'
        const host = args[2] || 'localhost'
        const port = parseInt(args[3] || String(config.defaultPort))
        const database = args[4] || ''
        const user = args[5] || ''
        const password = args[6] || ''
        return ctx.tools.execute('db_connect', { type, host, port, database, user, password })
      }
      if (sub === 'schemas') {
        return ctx.tools.execute('db_schemas', {})
      }
      if (sub === 'describe') {
        const table = args[1]
        if (!table) return { success: false, message: 'Usage: /db describe <table>' }
        return ctx.tools.execute('db_describe', { table })
      }
      if (sub === 'query') {
        const sql = args.slice(1).join(' ')
        if (!sql) return { success: false, message: 'Usage: /db query <sql>' }
        return ctx.tools.execute('db_query', { sql })
      }
      if (sub === 'er') {
        return ctx.tools.execute('db_er_diagram', {})
      }
      return { success: false, message: 'Usage: /db <connect|schemas|describe|query|er>' }
    },
  })
}
