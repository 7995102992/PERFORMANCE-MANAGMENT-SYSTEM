import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useLayoutVariant } from "@/contexts/layout-variant-context";
import { ModuleSelector } from "@/modules/super-admin/components/ModuleSelector";
import { useAppSelector } from "@/store";
import { useOrganisation } from "@/hooks/queries/use-organisation";
import { organisationService } from "@/api/org-setup";
import { queryKeys } from "@/api/query-keys";
import { toast } from "@/lib/toast";
import { useNavigationGuard } from "@/hooks/use-navigation-guard";
import {
  MODULE_DEFINITIONS,
  type ModuleKey,
  type OrgModule,
} from "@/api/super-admin/types";
import type { ModuleCatalogItem } from "@/api/super-admin/types";

export function ModuleManagementPage() {
  const variant = useLayoutVariant();
  const savedOrg = useAppSelector((s) => s.organisation.savedOrganisation);
  const { data: org, isLoading: orgLoading } = useOrganisation(
    savedOrg?.id ?? null,
  );
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<ModuleKey[]>([]);
  const [orgModules, setOrgModules] = useState<OrgModule[]>([]);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  useNavigationGuard(dirty);

  useEffect(() => {
    if (org?.enabled_modules) {
      const modules = (org.enabled_modules as OrgModule[]) ?? [];
      setOrgModules(modules);
      setSelected(modules.filter((m) => m.is_active).map((m) => m.code));
    }
  }, [org]);

  const assignedCatalog: ModuleCatalogItem[] = orgModules.map((m) => {
    const def = MODULE_DEFINITIONS.find((d) => d.key === m.code);
    return {
      id: m.code,
      code: m.code,
      label: def?.label ?? m.code,
      description: def?.description ?? "",
      mandatory: m.code === "core_hr",
    };
  });

  function handleChange(modules: ModuleKey[]) {
    setSelected(modules);
    setDirty(true);
  }

  async function handleSave() {
    if (!savedOrg?.id) return;
    setSaving(true);
    try {
      const updated: OrgModule[] = orgModules.map((m) => ({
        code: m.code,
        is_active: m.code === "core_hr" ? true : selected.includes(m.code),
      }));
      await organisationService.update(savedOrg.id, {
        enabled_modules: updated,
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.organisation.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.orgDashboard.stats });
      queryClient.invalidateQueries({ queryKey: queryKeys.moduleCatalog });
      toast.success("Modules updated successfully");
      setDirty(false);
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  }

  const skeletonGrid = (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-28 rounded-xl" />
      ))}
    </div>
  );

  const saveButton = (
    <Button variant="soft" onClick={handleSave} disabled={saving || !dirty}>
      {saving ? "Saving..." : "Save Changes"}
    </Button>
  );

  if (variant === "elevated") {
    if (orgLoading) {
      return (
        <Card className="gap-0 py-0">
          <div className="px-5 py-3.5 border-b border-border">
            <Skeleton className="h-4 w-40" />
          </div>
          <CardContent className="p-5">{skeletonGrid}</CardContent>
        </Card>
      );
    }
    return (
      <Card className="gap-0 py-0">
        <div className="px-5 py-3.5 border-b border-border">
          <h2 className="text-sm font-medium">Module Management</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Enable or disable modules assigned to your organisation. Core HR is
            mandatory.
          </p>
        </div>
        <CardContent className="p-5">
          <ModuleSelector
            selected={selected}
            onChange={handleChange}
            catalog={assignedCatalog}
          />
        </CardContent>
        <div className="px-5 py-3.5 border-t border-border">{saveButton}</div>
      </Card>
    );
  }

  if (orgLoading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-64" />
        {skeletonGrid}
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h2 className="text-sm font-semibold">Module Management</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Enable or disable modules assigned to your organisation. Core HR is
          mandatory.
        </p>
      </div>
      <ModuleSelector
        selected={selected}
        onChange={handleChange}
        catalog={assignedCatalog}
      />
      <div className="flex justify-start border-t pt-4">{saveButton}</div>
    </div>
  );
}
