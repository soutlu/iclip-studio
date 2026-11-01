import { createContext } from 'react'

/**
 * 对话所在的页面有没有工作台。没有时（Agent 配置页的测试预览）文件名、检索命中与派出子代理的卡不做成入口，
 * 轮尾的结果列表也不显示：它们都是在工作台里打开东西的入口，那里点了没有去处。
 */
export const WorkbenchLinksContext = createContext(true)
