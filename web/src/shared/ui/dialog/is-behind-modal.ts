export const isBehindModal = (element: Element | null): boolean =>
  element !== null && element.closest('[aria-hidden="true"]') !== null
