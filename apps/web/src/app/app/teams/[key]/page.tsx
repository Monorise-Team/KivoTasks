import { Skeleton } from "@monorise-team/ui";
import { Suspense } from "react";
import { TeamIssuesView } from "../../components/IssueListView";

export const dynamic = "force-dynamic";

export default async function TeamIssuesPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <TeamIssuesView teamKey={key} />
    </Suspense>
  );
}
