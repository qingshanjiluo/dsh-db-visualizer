import { describe, expect, it } from 'vitest'
import { apply, Config, inject, name } from '../src/index.ts'

interface RegisteredTool {
  name: string
  description: string
  execute(args: never, exec: never): Promise<unknown>
}

interface PluginConfig {
  includeComments: boolean
  indexNamePrefix: string
}

function mountPlugin(config: PluginConfig = { includeComments: true, indexNamePrefix: 'idx' }): RegisteredTool[] {
  const registered: RegisteredTool[] = []
  const ctx = { tools: { register: (def: RegisteredTool) => registered.push(def) } }
  // The plugin only reads ctx.tools; a partial stub is the real registrant surface it touches.
  apply(ctx as never, config as never)
  return registered
}

function tool(toolName: string, config?: PluginConfig): RegisteredTool {
  return mountPlugin(config).find((t) => t.name === toolName)!
}

const MYSQL_DDL = `
-- demo schema
/* block comment with ; semicolon and ) paren */
CREATE TABLE \`users\` (
  \`id\` int unsigned NOT NULL AUTO_INCREMENT,
  \`email\` varchar(255) NOT NULL,
  \`nickname\` varchar(50) DEFAULT NULL,
  \`role\` varchar(16) NOT NULL DEFAULT 'member',
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uq_email\` (\`email\`),
  KEY \`idx_nick\` (\`nickname\`)
) ENGINE=InnoDB COMMENT='site users';

CREATE TABLE \`orders\` (
  \`id\` bigint NOT NULL,
  \`user_id\` bigint NOT NULL COMMENT 'buyer',
  \`sku\` varchar(32),
  \`note\` text,
  PRIMARY KEY (\`id\`),
  KEY \`idx_user\` (\`user_id\`),
  CONSTRAINT \`fk_order_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE,
  FOREIGN KEY (\`sku\`) REFERENCES \`products\` (\`code\`)
);
`

const PG_DDL = `
CREATE TABLE public.accounts (
  id bigserial PRIMARY KEY,
  owner_id integer REFERENCES accounts (id),
  kind text NOT NULL CHECK (kind IN ('a', 'b')),
  email citext UNIQUE
);
COMMENT ON TABLE public.accounts IS 'user accounts';
COMMENT ON COLUMN public.accounts.owner_id IS 'self-owner';
`

describe('dsh-db-visualizer plugin contract', () => {
  it('exports the loader plugin face', () => {
    expect(name).toBe('dsh-db-visualizer')
    expect(inject).toEqual(['tools'])
    expect(typeof apply).toBe('function')
    expect(Config).toBeInstanceOf(Object)
  })

  it('registers the three documented tools', () => {
    const tools = mountPlugin()
    expect(tools.map((t) => t.name).sort()).toEqual(['db_analyze', 'db_er_mermaid', 'db_parse_schema'])
  })
})

describe('db_parse_schema', () => {
  it('parses MySQL dialect tables, keys, indexes, comments, and foreign keys', async () => {
    const result = await tool('db_parse_schema').execute({ ddlText: MYSQL_DDL } as never, {} as never) as any
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.tableCount).toBe(2)
    const [users, orders] = result.tables
    expect(users.name).toBe('users')
    expect(users.comment).toBe('site users')
    expect(users.primaryKey).toEqual(['id'])
    expect(users.columnCount).toBe(4)
    const id = users.columns.find((c: any) => c.name === 'id')
    expect(id).toMatchObject({ type: 'int unsigned', nullable: false, primaryKey: true, hasDefault: true })
    const email = users.columns.find((c: any) => c.name === 'email')
    expect(email).toMatchObject({ type: 'varchar(255)', nullable: false, unique: true })
    const nickname = users.columns.find((c: any) => c.name === 'nickname')
    expect(nickname.nullable).toBe(true)
    const role = users.columns.find((c: any) => c.name === 'role')
    expect(role.defaultValue).toBe('member')
    expect(users.indexes.map((ix: any) => ix.name)).toEqual(['uq_email', 'idx_nick'])
    expect(orders.foreignKeys).toHaveLength(2)
    expect(orders.foreignKeys[0]).toMatchObject({
      name: 'fk_order_user',
      columns: ['user_id'],
      referencedTable: 'users',
      referencedColumns: ['id'],
      onDelete: 'CASCADE',
    })
    expect(orders.columns.find((c: any) => c.name === 'user_id').comment).toBe('buyer')
  })

  it('parses PostgreSQL dialect: dotted names, serial, inline REFERENCES, CHECK IN enums, COMMENT ON', async () => {
    const result = await tool('db_parse_schema').execute({ ddlText: PG_DDL } as never, {} as never) as any
    expect(result.ok).toBe(true)
    const [accounts] = result.tables
    expect(accounts.name).toBe('accounts')
    expect(accounts.comment).toBe('user accounts')
    expect(accounts.primaryKey).toEqual(['id'])
    expect(accounts.columns.find((c: any) => c.name === 'id')).toMatchObject({ type: 'bigserial', nullable: false })
    expect(accounts.columns.find((c: any) => c.name === 'kind').enumValues).toEqual(['a', 'b'])
    expect(accounts.columns.find((c: any) => c.name === 'owner_id').comment).toBe('self-owner')
    expect(accounts.foreignKeys).toHaveLength(1)
    expect(accounts.foreignKeys[0]).toMatchObject({ columns: ['owner_id'], referencedTable: 'accounts', referencedColumns: ['id'] })
  })

  it('tolerates empty, non-DDL, and CTAS input, and reports unbalanced statements', async () => {
    const empty = await tool('db_parse_schema').execute({ ddlText: '' } as never, {} as never) as any
    expect(empty).toMatchObject({ ok: true, tableCount: 0, errors: [], tables: [] })
    const junk = await tool('db_parse_schema').execute({ ddlText: 'SELECT 1; -- nothing\n' } as never, {} as never) as any
    expect(junk.tableCount).toBe(0)
    const ctas = await tool('db_parse_schema').execute({ ddlText: 'CREATE TABLE t2 AS SELECT * FROM t1;' } as never, {} as never) as any
    expect(ctas.tableCount).toBe(0)
    const broken = await tool('db_parse_schema').execute({ ddlText: 'CREATE TABLE broken (id int' } as never, {} as never) as any
    expect(broken.ok).toBe(false)
    expect(broken.errors[0]).toContain('unbalanced parentheses')
  })

  it('honours includeComments=false', async () => {
    const result = await tool('db_parse_schema', { includeComments: false, indexNamePrefix: 'idx' })
      .execute({ ddlText: MYSQL_DDL } as never, {} as never) as any
    expect(result.tables[0].comment).toBe('')
    expect(result.tables[1].columns.find((c: any) => c.name === 'user_id').comment).toBe('')
  })
})

describe('db_er_mermaid', () => {
  it('renders entities with typed attributes and FK-derived relationships', async () => {
    const result = await tool('db_er_mermaid').execute({ ddlText: MYSQL_DDL } as never, {} as never) as any
    expect(result.ok).toBe(true)
    expect(result.tableCount).toBe(2)
    expect(result.relationCount).toBe(2)
    expect(result.mermaid.startsWith('erDiagram')).toBe(true)
    expect(result.mermaid).toContain('int_unsigned id PK')
    expect(result.mermaid).toContain('bigint user_id FK')
    expect(result.mermaid).toContain('varchar32 sku FK')
    expect(result.mermaid).toContain('users ||--o{ orders : "user_id"')
    // nullable FK → optional source side
    expect(result.mermaid).toContain('products |o--o{ orders : "sku"')
  })

  it('renders a self-referencing entity and stays valid on empty input', async () => {
    const pg = await tool('db_er_mermaid').execute({ ddlText: PG_DDL } as never, {} as never) as any
    expect(pg.mermaid).toContain('accounts |o--o{ accounts : "owner_id"')
    expect(pg.mermaid).toContain('text kind')
    const empty = await tool('db_er_mermaid').execute({ ddlText: 'not sql at all' } as never, {} as never) as any
    expect(empty.mermaid).toBe('erDiagram')
    expect(empty.relationCount).toBe(0)
    expect(empty.ok).toBe(true)
  })
})

describe('db_analyze', () => {
  it('flags missing indexes, dangling FKs, nullable FKs, and nullable columns without defaults', async () => {
    const result = await tool('db_analyze').execute({ ddlText: MYSQL_DDL } as never, {} as never) as any
    expect(result.ok).toBe(true)
    const byRule = (rule: string) => result.findings.filter((f: any) => f.rule === rule)
    expect(byRule('missing-index').some((f: any) => f.table === 'orders' && f.column === 'sku')).toBe(true)
    expect(byRule('missing-index').some((f: any) => f.column === 'user_id')).toBe(false)
    expect(byRule('missing-index')[0].message).toContain('CREATE INDEX idx_orders_sku')
    expect(byRule('dangling-fk').some((f: any) => f.table === 'orders' && f.message.includes('products'))).toBe(true)
    expect(byRule('nullable-fk-column').some((f: any) => f.column === 'sku')).toBe(true)
    expect(byRule('nullable-without-default').some((f: any) => f.column === 'note')).toBe(true)
    expect(byRule('missing-primary-key')).toEqual([])
    expect(result.totalFindings).toBe(result.findings.length)
  })

  it('reports a clean schema as having no findings', async () => {
    const ddl = `
      CREATE TABLE dep (id int NOT NULL, name text NOT NULL, PRIMARY KEY (id), UNIQUE (name));
      CREATE TABLE emp (
        id int NOT NULL,
        dep_id int NOT NULL,
        PRIMARY KEY (id),
        CONSTRAINT uq_emp_dep UNIQUE (dep_id),
        CONSTRAINT fk_emp_dep FOREIGN KEY (dep_id) REFERENCES dep (id)
      );
    `
    const result = await tool('db_analyze').execute({ ddlText: ddl } as never, {} as never) as any
    expect(result.findings).toEqual([])
    expect(result.totalFindings).toBe(0)
  })

  it('warns on tables without a primary key and honours indexNamePrefix in suggestions', async () => {
    const ddl = `
      CREATE TABLE audit_log (id bigint, msg text NOT NULL);
      CREATE TABLE events (
        id bigint NOT NULL,
        log_id bigint NOT NULL,
        PRIMARY KEY (id),
        FOREIGN KEY (log_id) REFERENCES audit_log (id)
      );
    `
    const result = await tool('db_analyze', { includeComments: true, indexNamePrefix: 'ix' })
      .execute({ ddlText: ddl } as never, {} as never) as any
    expect(result.findings.some((f: any) => f.rule === 'missing-primary-key' && f.table === 'audit_log')).toBe(true)
    const idx = result.findings.find((f: any) => f.rule === 'missing-index')
    expect(idx.message).toContain('CREATE INDEX ix_events_log_id ON events (log_id);')
  })
})
