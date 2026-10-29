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

export function fullCalendarMonthsInRange(startDate: string, endDate: string): string[] {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    start.toISOString().slice(0, 10) !== startDate ||
    end.toISOString().slice(0, 10) !== endDate ||
    startDate > endDate
  ) {
    throw new Error("Report dates must be valid ISO calendar dates");
  }

  const startMonth = `${startDate.slice(0, 7)}-01`;
  const endMonth = `${endDate.slice(0, 7)}-01`;
  const expectedEnd = monthRange(endMonth).end;
  const lastDay = new Date(`${expectedEnd}T00:00:00.000Z`);
  lastDay.setUTCDate(lastDay.getUTCDate() - 1);
  if (startDate !== startMonth || endDate !== lastDay.toISOString().slice(0, 10)) {
    throw new Error("Monthly reports require a full calendar month range");
  }

  const months = monthsInRange(startDate, endDate);
  if (months.length > 36) {
    throw new Error("Monthly reports are limited to 36 calendar months");
  }
  return months;
}
