const DEFAULT_PAGE_SIZE = 1000;

type Page<T> = {
  data: T[] | null;
  error: { message: string } | null;
};

type RangeQuery<T> = {
  range(from: number, to: number): PromiseLike<Page<T>>;
};

export async function fetchAllPages<T>(
  query: RangeQuery<T>,
  operation: string,
  pageSize = DEFAULT_PAGE_SIZE,
): Promise<T[]> {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error("pageSize must be a positive integer");
  }

  const rows: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await query.range(offset, offset + pageSize - 1);
    if (error) throw new Error(`${operation}: ${error.message}`);

    const page = data ?? [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}
