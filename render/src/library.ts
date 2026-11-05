import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ComponentCatalog } from '../../web/src/features/storyboard/whole-film/composition/catalog'

export interface ComponentLibrary {
  catalog: ComponentCatalog
  dir: string
}

export async function loadLibrary(root: string): Promise<ComponentLibrary> {
  const catalog = JSON.parse(await readFile(join(root, 'catalog.json'), 'utf8')) as ComponentCatalog
  return { catalog, dir: join(root, catalog.version) }
}
