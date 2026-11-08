export const cardOpenerProps = (cardId: string) => ({ 'data-open-card': cardId })

export const focusCardOpener = (root: HTMLElement | null, cardId: string): boolean => {
  const button = root?.querySelector<HTMLElement>(`[data-open-card="${cardId}"]`)
  button?.focus()
  return button != null
}
