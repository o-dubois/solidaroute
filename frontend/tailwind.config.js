/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        teal: {
          50:  '#e1f5ee', 100: '#9fe1cb', 200: '#5dcaa5',
          400: '#1d9e75', 600: '#0f6e56', 800: '#085041', 900: '#04342c',
        },
        brand: { DEFAULT: '#0f6e56', light: '#1d9e75', pale: '#e1f5ee' },
      },
      fontFamily: {
        sans: ['Segoe UI', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
