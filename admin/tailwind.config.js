/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0B0F1A',
        panel: '#111827',
        panel2: '#1A2236',
        border: '#1F2937',
        accent: '#F5C518',
        text: '#E6EAF2',
        muted: '#6B7280',
        good: '#22C55E',
        warn: '#EAB308',
        bad: '#EF4444',
      },
    },
  },
  plugins: [],
};
