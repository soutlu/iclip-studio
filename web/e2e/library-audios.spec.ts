import { expect, test } from '@playwright/test'
import { login } from './login'

const SAMPLE_AUDIO = new URL('../src/testing/fixtures/sample-audio.mp3', import.meta.url).pathname

test('资料库「音频库」添加一个带语种、性别、场景的音色：加好后排在最前，各列显示填的属性；切到配乐时地址记着子类', async ({
  page,
}) => {
  await page.goto('/')
  await login(page, 'tester')
  await page.getByRole('button', { name: '资料库' }).click()
  await page.getByRole('tab', { name: '音频库' }).click()
  await expect(page).toHaveURL(/tab=audios/)
  const main = page.getByRole('main', { name: '资料库' })
  await expect(main.getByText('共 3 个音色')).toBeVisible()

  await main.getByRole('button', { name: '添加音频' }).click()
  const dialog = page.getByRole('dialog', { name: '添加音频' })
  await expect(dialog.getByRole('radio', { name: '音色' })).toBeChecked()
  await dialog.getByLabel('选择音频文件').setInputFiles(SAMPLE_AUDIO)
  await expect(dialog.getByRole('textbox', { name: '名称' })).toHaveValue('sample-audio')
  await dialog.getByRole('textbox', { name: '名称' }).fill('店长口播')
  await dialog.getByRole('radio', { name: 'English' }).click()
  await dialog.getByRole('radio', { name: '男声' }).click()
  await dialog
    .getByRole('toolbar', { name: '适用场景' })
    .getByRole('button', { name: '纪录片' })
    .click()
  await dialog.getByRole('button', { name: '添加' }).click()
  await expect(dialog).toBeHidden()

  const voices = main.getByRole('list', { name: '音色' })
  const first = voices.getByRole('listitem').first()
  await expect(first).toContainText('店长口播')
  await expect(first).toContainText('English')
  await expect(first).toContainText('男声')
  await expect(first).toContainText('纪录片')
  await expect(main.getByText('共 4 个音色')).toBeVisible()

  await main
    .getByRole('radiogroup', { name: '音频类型' })
    .getByRole('radio', { name: /^配乐/ })
    .click()
  await expect(page).toHaveURL(/audioKind=bgm/)
  await expect(main.getByText('共 2 首配乐')).toBeVisible()
  await expect(main.getByRole('list', { name: '配乐' }).getByRole('listitem')).toHaveCount(2)
})
