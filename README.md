# dsh-db-visualizer

DeepSeek Harness plugin: offline SQL DDL schema visualization and analysis.

Paste `CREATE TABLE` text (MySQL, PostgreSQL, or SQLite dialect) into the
tools; they parse it in-process and return structure, a Mermaid ER diagram,
and schema-hygiene findings. **No database connection, no subprocesses, no
network** — every tool is a pure DDL text analysis.

## Install

```bash
npx -y @deepseek-ai/dsh plugin --profile web add @qingshanjiluo/dsh-db-visualizer
```

## Tools

| Tool | Input | Output |
|------|-------|--------|
| `db_parse_schema` | `ddlText` — raw DDL script | Tables with columns (type, nullability, defaults, comments, ENUM/CHECK values), primary keys, indexes, and foreign keys (target, ON DELETE/UPDATE) |
| `db_er_mermaid` | `ddlText` | Mermaid `erDiagram` source with typed attributes (PK/FK/UK) and FK-derived relationship lines, plus table/relation counts |
| `db_analyze` | `ddlText` | Findings: `missing-index` on foreign keys (with a suggested `CREATE INDEX`), `missing-primary-key`, `nullable-fk-column`, `nullable-unique-column`, `nullable-without-default`, `dangling-fk` |

## Configuration

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `includeComments` | boolean | `true` | Expose `COMMENT` text declared in the DDL |
| `indexNamePrefix` | string | `idx` | Prefix for index names suggested by `db_analyze` |

## Parsing notes

The parser is string-aware and line/regex based: it understands quoted
identifiers (`` `x` ``, `"x"`, `[x]`), schema-qualified names, inline and
table-level `PRIMARY KEY` / `UNIQUE` / `FOREIGN KEY ... REFERENCES` /
`KEY|INDEX` items, `ENUM('...')` and `CHECK (col IN (...))` value sets, and
`COMMENT=` / `COMMENT ON TABLE|COLUMN` comments. `CREATE TABLE ... AS SELECT`
is skipped; structural problems are reported in the `errors` array instead of
throwing.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsc + tsdown → lib/
npx vitest run      # behavior tests
node scripts/load-smoke.mjs   # loads lib/index.js, asserts the tool face
```

## License

MIT
