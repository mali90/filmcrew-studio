/** Tailwind rides the CSS-variable token system in src/styles/tokens.css — semantic names only,
 *  so the whole app rethemes (dark/light) by flipping [data-theme]. */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        surface: { 0: 'var(--surface-0)', 1: 'var(--surface-1)', 2: 'var(--surface-2)', 3: 'var(--surface-3)' },
        stage: 'var(--stage)',
        ink: { DEFAULT: 'var(--ink)', secondary: 'var(--ink-secondary)', muted: 'var(--ink-muted)', faint: 'var(--ink-faint)' },
        line: { DEFAULT: 'var(--line)', strong: 'var(--line-strong)' },
        accent: { DEFAULT: 'var(--accent)', hover: 'var(--accent-hover)', strong: 'var(--accent-strong)', soft: 'var(--accent-soft)' },
        onaccent: 'var(--on-accent)',
        status: {
          pending: 'var(--status-pending)',
          active: 'var(--status-active)',
          done: 'var(--status-done)',
          failed: 'var(--status-failed)',
          warn: 'var(--status-warn)',
        },
      },
      borderRadius: { r1: '4px', r2: '6px', r3: '10px', r4: '14px' },
      fontFamily: {
        sans: ['InterVariable', 'Inter', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SF Mono', 'monospace'],
      },
      fontSize: {
        display: ['28px', { lineHeight: '34px', fontWeight: '600', letterSpacing: '-0.02em' }],
        title: ['20px', { lineHeight: '28px', fontWeight: '600', letterSpacing: '-0.015em' }],
        heading: ['16px', { lineHeight: '24px', fontWeight: '600', letterSpacing: '-0.01em' }],
        label: ['13px', { lineHeight: '18px', fontWeight: '500', letterSpacing: '0.01em' }],
        body: ['14px', { lineHeight: '21px' }],
        dense: ['13px', { lineHeight: '18px' }],
        caption: ['12px', { lineHeight: '16px', letterSpacing: '0.01em' }],
      },
    },
  },
  plugins: [],
};
