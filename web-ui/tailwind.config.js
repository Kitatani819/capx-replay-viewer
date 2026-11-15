/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Space Grotesk', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        surface: {
          DEFAULT: 'rgb(var(--replay-surface) / <alpha-value>)',
          raised: 'rgb(var(--replay-raised) / <alpha-value>)',
          overlay: 'rgb(var(--replay-overlay) / <alpha-value>)',
          sunken: 'rgb(var(--replay-sunken) / <alpha-value>)',
          border: 'rgb(var(--replay-border) / <alpha-value>)',
          'border-light': 'rgb(var(--replay-border-light) / <alpha-value>)',
        },
        sand: {
          50: '#fafafa',
          100: '#f0f0f0',
          200: '#d4d4d4',
          300: '#a3a3a3',
          400: '#737373',
          500: '#525252',
          600: '#404040',
          700: '#2a2a2a',
          800: '#1a1a1a',
          900: '#0a0a0a',
        },
        accent: {
          DEFAULT: 'rgb(var(--replay-accent) / <alpha-value>)',
          light: 'rgb(var(--replay-accent-light) / <alpha-value>)',
          dark: 'rgb(var(--replay-accent-dark) / <alpha-value>)',
        },
        nv: {
          green: '#76b900',
          'green-light': '#8ecf10',
        },
        text: {
          primary: 'rgb(var(--replay-text-primary) / <alpha-value>)',
          secondary: 'rgb(var(--replay-text-secondary) / <alpha-value>)',
          tertiary: 'rgb(var(--replay-text-tertiary) / <alpha-value>)',
          muted: 'rgb(var(--replay-text-muted) / <alpha-value>)',
        },
      },
      fontSize: {
        'display': ['2.5rem', { lineHeight: '1.1', letterSpacing: '0.08em' }],
      },
      borderWidth: {
        '3': '3px',
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'shimmer': 'shimmer 2s ease-in-out infinite',
        'glow-pulse': 'glowPulse 2s ease-in-out infinite',
        'slide-in': 'slideIn 0.4s ease-out',
        'pulse-gold': 'pulse-gold 2s ease-in-out infinite',
        'slide-in-left': 'slideInLeft 0.3s cubic-bezier(0.25, 1, 0.5, 1)',
        'slide-in-right': 'slideInRight 0.3s cubic-bezier(0.25, 1, 0.5, 1)',
        'scale-in': 'scaleIn 0.25s cubic-bezier(0.25, 1, 0.5, 1)',
        'expand': 'expandHeight 0.3s cubic-bezier(0.25, 1, 0.5, 1)',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '0%, 100%': { opacity: '0.5' },
          '50%': { opacity: '1' },
        },
        glowPulse: {
          '0%, 100%': { boxShadow: '0 0 8px 0 rgba(212, 160, 23, 0.15)' },
          '50%': { boxShadow: '0 0 16px 2px rgba(212, 160, 23, 0.3)' },
        },
        slideIn: {
          from: { opacity: '0', transform: 'translateX(-8px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'pulse-gold': {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '1' },
        },
        slideInLeft: {
          '0%': { opacity: '0', transform: 'translateX(-12px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        slideInRight: {
          '0%': { opacity: '0', transform: 'translateX(12px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        scaleIn: {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        expandHeight: {
          '0%': { opacity: '0', maxHeight: '0' },
          '100%': { opacity: '1', maxHeight: '500px' },
        },
      },
    },
  },
  plugins: [],
}
