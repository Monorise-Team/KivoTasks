import { Skeleton } from "@monorise-team/ui";
import { Suspense } from "react";
import { TeamBoardView } from "../../../components/TeamBoardView";

export const dynamic = "force-dynamic";

export default async function TeamBoardPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <TeamBoardView teamKey={key} />
    </Suspense>
  );
}
