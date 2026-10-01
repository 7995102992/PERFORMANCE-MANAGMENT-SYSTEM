import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/EmptyState";

interface RecordNotFoundProps {
  /** Singular, lowercase — e.g. "project", "client" */
  entity: string;
  /** Where "Back" goes */
  onBack: () => void;
  backLabel?: string;
}

/**
 * Shown when a detail endpoint answers 404. Projects and clients are scoped to
 * the caller, so a 404 means either "deleted" or "not yours" — the backend does
 * not distinguish, and neither should the copy. Never a crash page, never a
 * logout: only 401 ends the session.
 */
export function RecordNotFound({
  entity,
  onBack,
  backLabel,
}: RecordNotFoundProps) {
  return (
    <div className="p-6">
      <EmptyState
        icon={Lock}
        variant="warning"
        title={`This ${entity} isn't available`}
        description={`It may have been deleted, or it isn't one of the ${entity}s assigned to you. Ask an administrator if you think you should have access.`}
        action={
          <Button variant="outline" onClick={onBack}>
            {backLabel ?? "Back"}
          </Button>
        }
      />
    </div>
  );
}
