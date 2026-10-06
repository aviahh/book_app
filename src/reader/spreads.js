// Page ↔ spread arithmetic.
//
// Double mode mirrors a physical book: the cover (page 1) sits alone, then
// pages pair up as [2,3], [4,5], … and an even last page sits alone as the
// back cover. Spread i shows pages 2i (left) and 2i+1 (right), clipped to the
// book; a missing side is null.

export function spreadCount(mode, total) {
  return mode === 'double' ? Math.floor(total / 2) + 1 : total;
}

export function spreadOf(mode, page) {
  return mode === 'double' ? Math.floor(page / 2) : page - 1;
}

export function spreadPages(mode, index, total) {
  if (mode !== 'double') return { left: null, right: null, single: index + 1 };
  const l = 2 * index;
  const r = 2 * index + 1;
  return { left: l >= 1 && l <= total ? l : null, right: r <= total ? r : null };
}

export const visiblePages = (s) => (s.single ? [s.single] : [s.left, s.right].filter(Boolean));

export function spreadLabel(mode, index, total) {
  const pages = visiblePages(spreadPages(mode, index, total));
  return pages.length === 2 ? `${pages[0]}-${pages[1]}` : `${pages[0]}`;
}
