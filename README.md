# dsh-db-visualizer

> DeepSeek Harness 数据库 Schema 可视化

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## ✨ 功能特性

- 🔌 **数据库连接**: 支持 PostgreSQL、MySQL、SQLite
- 📋 **Schema 浏览**: 列出所有表、行数、列信息
- 🔍 **表结构**: 显示列、类型、约束、索引、外键
- 📊 **SQL 查询**: 执行只读 SELECT 查询
- 🗺️ **ER 图**: 生成 Mermaid 语法的实体关系图
- 📈 **分析**: 表大小、索引使用、优化建议

## 📦 安装

```bash
npm install dsh-db-visualizer
```

## 🛠️ 工具

| 工具名 | 描述 | 参数 |
|--------|------|------|
| `db_connect` | 连接数据库 | `type`, `host`, `port`, `database`, `user`, `password` |
| `db_schemas` | 列出所有表 | 无 |
| `db_describe` | 描述表结构 | `table` |
| `db_query` | 执行只读查询 | `sql` |
| `db_er_diagram` | 生成 ER 图 | 无 |
| `db_analyze` | 数据库分析 | 无 |

## 📋 命令

- `/db connect` — 连接数据库
- `/db schemas` — 列出表
- `/db describe <table>` — 描述表
- `/db query <sql>` — 执行查询
- `/db er` — 生成 ER 图

## 📄 License

MIT
