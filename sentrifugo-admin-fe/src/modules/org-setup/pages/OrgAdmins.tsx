import { Card, CardContent } from "@/components/ui/card";
import { OrgAdminsManager } from "@/components/shared/OrgAdminsManager";
import { useLayoutVariant } from "@/contexts/layout-variant-context";
import { useAppSelector } from "@/store";

export function OrgAdminsPage() {
  const variant = useLayoutVariant();
  const organisationId = useAppSelector(
    (s) => s.organisation.savedOrganisation?.id,
  );

  if (variant === "elevated") {
    return (
      <Card className="gap-0 py-0">
        <div className="px-5 py-3.5 border-b border-border">
          <h2 className="text-sm font-medium">Organisation Admins</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Add and manage administrators for your organisation
          </p>
        </div>
        <CardContent className="p-5">
          <OrgAdminsManager organisationId={organisationId} />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h2 className="text-sm font-semibold">Organisation Admins</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Add and manage administrators for your organisation
        </p>
      </div>
      <OrgAdminsManager organisationId={organisationId} />
    </div>
  );
}
