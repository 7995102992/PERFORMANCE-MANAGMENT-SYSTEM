import * as React from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";
import {
  PermissionGridEditor,
  type PermissionGridEditorRef,
} from "../Designations/PermissionGridEditor";
import { usePolicyPermissions, useRoles } from "@/hooks/queries/use-policies";
import { policiesService } from "@/api/org-setup";
import { useScrollToError } from "@/hooks/use-scroll-to-error";
import { useNavigationGuard } from "@/hooks/use-navigation-guard";
import type {
  PolicyResponseDTO,
  PolicyPermissionsMap,
} from "@/api/org-setup/types";

// ─── Shared form-data shape ─────────────────────────────────────────────────

export interface RoleFormData {
  name: string;
  permissions: PolicyPermissionsMap;
  status: boolean;
}

interface RoleFormProps {
  editingRole?: PolicyResponseDTO | null;
  onSave?: (data: RoleFormData) => void;
  onCancel: () => void;
  viewMode?: boolean;
  isSaving?: boolean;
  onEdit?: () => void;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function RoleForm({
  editingRole = null,
  onSave,
  onCancel,
  viewMode = false,
  isSaving = false,
  onEdit,
}: RoleFormProps) {
  const scrollToError = useScrollToError();
  const gridRef = React.useRef<PermissionGridEditorRef>(null);

  const [name, setName] = React.useState(editingRole?.name ?? "");
  const [status, setStatus] = React.useState(editingRole?.is_active ?? true);
  const [submitted, setSubmitted] = React.useState(false);
  const [hasEdited, setHasEdited] = React.useState(false);

  const isEditing = !!editingRole;
  useNavigationGuard(hasEdited && !viewMode);

  // This role's permission grid (edit/view mode) → seeds the editor.
  const { data: existingPerms } = usePolicyPermissions(editingRole?.id ?? null);
  const initialGrid = existingPerms?.permissions;

  // Other roles to copy permissions from.
  const { data: rolesResp } = useRoles({ limit: 100 });
  const copyOptions = (rolesResp?.items ?? [])
    .filter((r) => r.id !== editingRole?.id)
    .map((r) => ({ label: r.name, value: r.id }));

  async function handleCopyFrom(
    roleId: string,
  ): Promise<PolicyPermissionsMap | null> {
    const res = await policiesService.getPermissions(roleId);
    return res.permissions;
  }

  const trimmedName = name.trim();
  const nameError = submitted
    ? !trimmedName
      ? "Role name is required"
      : trimmedName.length > 100
        ? "Must be 100 characters or less"
        : undefined
    : undefined;

  const isValid = !!trimmedName && trimmedName.length <= 100;

  function handleSave() {
    setSubmitted(true);
    if (!isValid) {
      requestAnimationFrame(() => scrollToError());
      return;
    }
    onSave?.({
      name: trimmedName,
      permissions: gridRef.current?.getGrid() ?? {},
      status,
    });
  }

  const title = viewMode ? "View Role" : isEditing ? "Edit Role" : "Add Role";
  const subtitle = viewMode
    ? "Role details are shown below."
    : isEditing
      ? "Update the role and its permissions below."
      : "Create a new role and define its permissions.";

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-xl">Roles</h1>
        <p className="text-sm text-muted-foreground">
          Define reusable roles and the permissions they grant. Assign a role to
          employees from the employee form.
        </p>
      </div>

      <Card className="max-w-full overflow-hidden">
        <CardContent className="space-y-6 min-w-0">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">{title}</h2>
              <p className="text-sm text-muted-foreground">{subtitle}</p>
            </div>
            {(isEditing || viewMode) &&
              (viewMode ? (
                <div className="flex items-center gap-4">
                  <span
                    className={
                      status
                        ? "text-sm font-medium text-success"
                        : "text-sm text-muted-foreground"
                    }
                  >
                    {status ? "Active" : "Inactive"}
                  </span>
                  {onEdit && (
                    <Button type="button" variant="soft" onClick={onEdit}>
                      <Pencil />
                      Edit
                    </Button>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <span className="text-sm text-muted-foreground">Inactive</span>
                  <Switch
                    checked={status}
                    onCheckedChange={(v) => {
                      setStatus(v);
                      setHasEdited(true);
                    }}
                  />
                  <span className="text-sm text-muted-foreground">Active</span>
                </div>
              ))}
          </div>

          {/* Role Name */}
          <div className="space-y-3 max-w-md">
            <label className="text-sm font-medium text-label tracking-wider">
              Role Name <span className="text-destructive">*</span>
            </label>
            {viewMode ? (
              <p className="text-sm text-foreground py-2">{name || "—"}</p>
            ) : (
              <>
                <Input
                  placeholder="Enter role name"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setHasEdited(true);
                  }}
                  maxLength={100}
                />
                {nameError && (
                  <p className="text-sm text-destructive">{nameError}</p>
                )}
              </>
            )}
          </div>

          {/* Permissions */}
          <div className="border-t pt-5">
            <h3 className="text-sm font-semibold text-label uppercase tracking-wide">
              Permissions
            </h3>
            <p className="text-xs text-muted-foreground mt-1 mb-4">
              Define what employees with this role can access.
              {!viewMode &&
                " You can copy the permissions from another role to start."}
            </p>
            <PermissionGridEditor
              ref={gridRef}
              initialGrid={initialGrid}
              disabled={viewMode}
              onDirty={() => setHasEdited(true)}
              copyOptions={viewMode ? undefined : copyOptions}
              onCopyFrom={handleCopyFrom}
            />
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            {viewMode ? (
              <Button variant="outline" onClick={onCancel}>
                Back
              </Button>
            ) : (
              <>
                <Button variant="outline" onClick={onCancel}>
                  Cancel
                </Button>
                <Button variant="soft" onClick={handleSave} disabled={isSaving}>
                  {isSaving ? "Saving..." : isEditing ? "Update" : "Save"}
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
