import React from 'react';
import { createSettingsCard } from '@deepseek-ai/dsh-settings';

export default createSettingsCard({
  title: 'db-visualizer',
  description: '数据库 Schema 可视化',
  config: [
    { key: 'enabled', type: 'boolean', label: '启用插件', default: true },
    { key: 'defaultPort', type: 'number', label: '默认端口', default: 5432 },
    { key: 'maxRows', type: 'number', label: '最大返回行数', default: 100 },
  ],
});
