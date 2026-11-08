type BrowserMockProfile = 'disabled' | 'full'

export type DevServerProfile = {
  browserMocks: BrowserMockProfile
  proxyBackend: boolean
}

export const resolveDevServerProfile = (mode: string): DevServerProfile => {
  if (mode === 'mock') {
    return { browserMocks: 'full', proxyBackend: false }
  }

  if (['backend', 'development', 'production', 'test'].includes(mode)) {
    return { browserMocks: 'disabled', proxyBackend: true }
  }

  throw new Error(`未知 Vite mode：${mode}`)
}
