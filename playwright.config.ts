import { defineConfig, devices } from '@playwright/test'

// 本地 Chrome for Testing 路径（D:\workplace\workTool）— 跟 Playwright 1.60 兼容
// 没装/改路径时，注释这两行 + 删 use.launchOptions 段落即可走默认 chromium
const LOCAL_CHROME = process.env.LOCAL_CHROME
  ?? 'D:/workplace/workTool/chrome-win64/chrome.exe'

// FE dev server 端口（webServer 起这个 / baseURL 用这个）
const FE_PORT = Number(process.env.FE_PORT ?? 4010)

// BE 必须先手动起 (mvn spring-boot:run -pl ruoyi-admin), 默认 8080
// 测试通过 /api proxy 间接打 BE
export default defineConfig({
  testDir: './tests',
  timeout: 60000,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: `http://localhost:${FE_PORT}`,
    screenshot: 'only-on-failure',
    video: 'off',
    headless: process.env.HEADED !== '1',
    actionTimeout: 10000,
    navigationTimeout: 15000,
  },
  projects: [
    {
      name: 'chromium-local',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          executablePath: LOCAL_CHROME,
        },
      },
    },
  ],
  webServer: {
    command: `pnpm dev --port ${FE_PORT}`,
    url: `http://localhost:${FE_PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
})
