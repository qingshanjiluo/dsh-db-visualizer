/**
 * Loads the built artifact and asserts it exports the Cordis function-plugin
 * face the harness loader requires. Run after `npm run build`.
 * @module
 */
import assert from 'node:assert/strict'

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

assert.equal(mod.name, 'dsh-db-visualizer', 'plugin name export')
assert.deepEqual(mod.inject, ['tools'], 'inject declares the tools service')
assert.equal(typeof mod.apply, 'function', 'apply is a function')
assert.ok(mod.Config, 'Config schema export present')

const registered = []
mod.apply({ tools: { register: (def) => registered.push(def) } }, { includeComments: true, indexNamePrefix: 'idx' })
assert.deepEqual(registered.map((t) => t.name).sort(), ['db_analyze', 'db_er_mermaid', 'db_parse_schema'], 'all three tools register')

// Exercise one pure round-trip against the built artifact.
const parse = registered.find((t) => t.name === 'db_parse_schema')
const result = await parse.execute(
  { ddlText: 'CREATE TABLE t (id int NOT NULL, PRIMARY KEY (id));' },
  {},
)
assert.equal(result.ok, true)
assert.equal(result.tableCount, 1)
assert.equal(result.tables[0].name, 't')
assert.deepEqual(result.tables[0].primaryKey, ['id'])

console.log('load-smoke: ok —', registered.length, 'tools registered from built artifact')
