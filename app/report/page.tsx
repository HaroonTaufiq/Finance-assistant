import { redirect } from "next/navigation";
import { MonthlyReport } from "@/components/monthly-report";
import { getCurrentUser } from "@/lib/db/client";

export default async function ReportPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <MonthlyReport />;
}
