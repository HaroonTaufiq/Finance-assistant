const pad2 = (n: number) => String(n).padStart(2, "0");

export function monthRange(monthStart: string): { start: string; end: string } {
  const [year, month] = monthStart.split("-").map(Number) as [number, number];
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;

  return {
    start: monthStart,
    end: `${nextYear}-${pad2(nextMonth)}-01`,
  };
}

export function monthsInRange(startDate: string, endDate: string): string[] {
  const months: string[] = [];
  let year = Number(startDate.slice(0, 4));
  let month = Number(startDate.slice(5, 7));
  const endYear = Number(endDate.slice(0, 4));
  const endMonth = Number(endDate.slice(5, 7));

  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${year}-${pad2(month)}-01`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return months;
}
