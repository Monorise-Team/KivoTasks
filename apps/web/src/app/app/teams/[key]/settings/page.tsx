import { TeamSettingsView } from "../../../components/TeamSettingsView";

export const dynamic = "force-dynamic";

export default async function TeamSettingsPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return <TeamSettingsView teamKey={key} />;
}
