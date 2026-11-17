import { expect, test } from '@playwright/test'
import { login } from './login'

const SAMPLE_AUDIO = new URL('../src/testing/fixtures/sample-audio.mp3', import.meta.url).pathname

test('资料库「音频库」添加一个音色：上传音频、填语种，加好后排在最前，筛「音色」也在，地址里记着筛选', async ({
  page,
}) => {
  await page.goto('/')
  await login(page, 'tester')
  await page.getByRole('button', { name: '资料库' }).click()
  await page.getByRole('tab', { name: '音频库' }).click()
  await expect(page).toHaveURL(/tab=audios/)
  const main = page.getByRole('main', { name: '资料库' })
  await expect(main.getByText('共 6 条')).toBeVisible()

  await main.getByRole('button', { name: '添加音频' }).click()
  const dialog = page.getByRole('dialog', { name: '添加音频' })
  await dialog.getByRole('radio', { name: '音色' }).click()
  await dialog.getByLabel('选择音频文件').setInputFiles(SAMPLE_AUDIO)
  await expect(dialog.getByRole('textbox', { name: '标题' })).toHaveValue('sample-audio')
  await dialog.getByRole('textbox', { name: '标题' }).fill('店长口播')
  await dialog.getByRole('combobox', { name: '语种' }).selectOption('en')
  await dialog.getByRole('button', { name: '添加' }).click()
  await expect(dialog).toBeHidden()

  const list = main.getByRole('list', { name: '音频' })
  await expect(list.getByRole('listitem').first()).toContainText('店长口播')
  await expect(list.getByRole('listitem').first()).toContainText('音色 · English · 0:06 · tester')
  await expect(main.getByText('共 7 条')).toBeVisible()

  await main
    .getByRole('radiogroup', { name: '音频类型' })
    .getByRole('radio', { name: /^音色/ })
    .click()
  await expect(page).toHaveURL(/audioKind=voice/)
  await expect(main.getByText('找到 4 条')).toBeVisible()
  await expect(list.getByRole('listitem').first()).toContainText('店长口播')
})
