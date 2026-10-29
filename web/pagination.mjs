export const PAGE_SIZE = 20;

export function paginate(items, requestedPage = 1) {
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const page = Math.min(totalPages, Math.max(1, Number.isInteger(requestedPage) ? requestedPage : 1));
  return { items: items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), page, totalPages, total: items.length };
}

export function paginationMarkup({ page, totalPages, total }, key) {
  if (totalPages <= 1) return "";
  return `<nav class="list-pagination" aria-label="列表分页" data-pagination="${key}"><span>共 ${total} 条 · 每页 ${PAGE_SIZE} 条 · 第 ${page}/${totalPages} 页</span><div><button type="button" class="small-button" data-page="${page - 1}" ${page === 1 ? "disabled" : ""}>上一页</button><button type="button" class="small-button" data-page="${page + 1}" ${page === totalPages ? "disabled" : ""}>下一页</button></div></nav>`;
}
