import { useSearch } from "@tanstack/react-router";
import ClientProjectHeads from "./ClientProjectHeads";
import { PageHeader } from "@/components/shared/PageHeader";

const ProjectHeadsPage = () => {
  const search = useSearch({ strict: false }) as { new?: string };
  return (
    <div className="space-y-6">
      <PageHeader
        title="Client Project Heads"
        subtitle="Manage project head contacts for clients"
      />
      <ClientProjectHeads initialFormOpen={search.new === "true"} />
    </div>
  );
};

export default ProjectHeadsPage;
