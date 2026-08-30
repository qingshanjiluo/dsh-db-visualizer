import React from 'react'

export const inject = ['settingsScope', 'slots', 'locale'] as const

export function apply(ctx: any) {
  ctx.locale.register('dsh-db-visualizer', {
    zh: {
      title: '数据库可视化',
      enabled: '启用',
      defaultPort: '默认端口',
      maxRows: '最大行数',
    },
    en: {
      title: 'Database Visualizer',
      enabled: 'Enabled',
      defaultPort: 'Default Port',
      maxRows: 'Max Rows',
    },
  })

  ctx.slots.register('settings', () => {
    return React.createElement(DBCard)
  })
}

function DBCard() {
  const settingsScope = ctx.settingsScope
  const locale = ctx.locale.use()
  const t = locale.t('dsh-db-visualizer')

  const config = settingsScope.get('dsh-db-visualizer') ?? {
    enabled: true,
    defaultPort: 5432,
    maxRows: 100,
  }

  const update = (patch: Record<string, any>) => {
    settingsScope.set('dsh-db-visualizer', { ...config, ...patch })
  }

  return React.createElement(
    'div',
    {
      style: {
        padding: '16px',
        borderRadius: '8px',
        border: '1px solid var(--border)',
        background: 'var(--card-bg)',
      },
    },
    React.createElement('h3', { style: { margin: '0 0 12px 0', fontSize: '14px', fontWeight: 600 } }, t.title),
    React.createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      React.createElement(
        'label',
        { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
        React.createElement('input', {
          type: 'checkbox',
          checked: config.enabled,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => update({ enabled: e.target.checked }),
        }),
        t.enabled
      ),
      React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        React.createElement('label', { style: { fontSize: '13px', color: 'var(--text-secondary)' } }, t.defaultPort),
        React.createElement('input', {
          type: 'number',
          value: config.defaultPort,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => update({ defaultPort: parseInt(e.target.value) || 5432 }),
          style: {
            padding: '6px 8px',
            borderRadius: '4px',
            border: '1px solid var(--border)',
            background: 'var(--input-bg)',
            fontSize: '13px',
          },
        })
      ),
      React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        React.createElement('label', { style: { fontSize: '13px', color: 'var(--text-secondary)' } }, t.maxRows),
        React.createElement('input', {
          type: 'number',
          value: config.maxRows,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => update({ maxRows: parseInt(e.target.value) || 100 }),
          style: {
            padding: '6px 8px',
            borderRadius: '4px',
            border: '1px solid var(--border)',
            background: 'var(--input-bg)',
            fontSize: '13px',
          },
        })
      )
    )
  )
}
