module.exports = {
  content: ['./App.{js,jsx,ts,tsx}', './src/**/*.{js,jsx,ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        bg: '#0B0F1A',
        panel: '#121826',
        panel2: '#1A2236',
        border: '#222B45',
        accent: '#F5C518',
        accentDim: '#8A6F00',
        text: '#E6EAF2',
        muted: '#8A93A6',
        good: '#22C55E',
        warn: '#EAB308',
        bad: '#EF4444',
      },
    },
  },
  plugins: [],
};
