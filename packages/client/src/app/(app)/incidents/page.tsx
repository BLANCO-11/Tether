// src/app/(app)/incidents/page.tsx — backward-compat redirect.
// The canonical incident list is /admin/incidents; this path stays reachable
// so old links keep working.
import { redirect } from "next/navigation";

export default function IncidentsRootPage(): JSX.Element {
  redirect("/admin/incidents");
  return <></>;
}
