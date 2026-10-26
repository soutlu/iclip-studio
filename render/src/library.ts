/**
 * 组件库：部署目录挂进来的 `<RENDER_REGISTRY_ROOT>`，根上是组件目录 catalog.json，组件文件在
 * `<version>/` 下。发布新组件库时先放好新的版本目录、再原子替换 catalog.json，所以每次读到的
 * catalog.json 都指向一个完整的版本目录；渲染服务每次受理导出都重新读，不必重启。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ComponentCatalog } from '../../web/src/features/storyboard/whole-film/composition/catalog'

export interface ComponentLibrary {
  catalog: ComponentCatalog
  /** 这一版组件文件所在的目录。 */
  dir: string
}

/** 读组件库根上的 catalog.json；读不到或不是 JSON 时抛出。 */
export async function loadLibrary(root: string): Promise<ComponentLibrary> {
  // catalog.json 由组装工具写出，形状即 ComponentCatalog（JSON 推不出字面量联合）。
  const catalog = JSON.parse(await readFile(join(root, 'catalog.json'), 'utf8')) as ComponentCatalog
  return { catalog, dir: join(root, catalog.version) }
}
