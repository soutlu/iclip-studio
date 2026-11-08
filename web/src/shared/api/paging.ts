export interface DrainedPage<Item, Token> {
  items: readonly Item[]
  next: Token | null
}

export const drainPages = async <Item, Token>(
  fetchPage: (token: Token | undefined) => Promise<DrainedPage<Item, Token>>,
): Promise<Item[]> => {
  const items: Item[] = []
  let token: Token | undefined

  for (;;) {
    const page = await fetchPage(token)
    items.push(...page.items)
    if (page.next === null) return items
    token = page.next
  }
}
