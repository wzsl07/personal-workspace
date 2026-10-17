/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // 深色优先（IDE 主题为 dark），全部本地色值，不引远程字体/图标
        bg: {
          base: '#0f1115',
          panel: '#151923',
          elev: '#1b2030',
          hover: '#232a3d',
        },
        line: '#2a3145',
        fg: {
          DEFAULT: '#e6e9f0',
          muted: '#9aa4bd',
          dim: '#6b7590',
        },
        accent: '#5b8cff',
        // 条目类型色（日历/看板/时间轴共用同一套）
        t: {
          task: '#5b8cff',
          todo: '#7c8aa5',
          assignment: '#f0a13c',
          course: '#3fb984',
          classAffair: '#b06cf0',
          activity: '#e8577f',
          exam: '#e5484d',
          meeting: '#2fb8c6',
          custom: '#8b93a7',
        },
        // 优先级：低/中/高/紧急
        p: {
          1: '#6b7590',
          2: '#5b8cff',
          3: '#f0a13c',
          4: '#e5484d',
        },
      },
      fontFamily: {
        sans: [
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Microsoft YaHei',
          'PingFang SC',
          'Hiragino Sans GB',
          'sans-serif',
        ],
        mono: ['ui-monospace', 'Consolas', 'Menlo', 'monospace'],
      },
      borderRadius: {
        lg: '10px',
      },
    },
  },
  plugins: [],
};
