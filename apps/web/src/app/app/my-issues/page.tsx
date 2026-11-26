import { Skeleton } from "@monorise-team/ui";
import { Suspense } from "react";
import { MyIssuesView } from "../components/IssueListView";

export const dynamic = "force-dynamic";

export default function MyIssuesPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <MyIssuesView />
    </Suspense>
  );
}
