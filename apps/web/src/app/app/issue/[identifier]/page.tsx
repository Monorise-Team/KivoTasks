import { IssueDetailView } from "../../components/IssueDetailView";

export const dynamic = "force-dynamic";

export default async function IssueDetailPage({ params }: { params: Promise<{ identifier: string }> }) {
  const { identifier } = await params;
  return <IssueDetailView identifier={identifier} />;
}
