import { useEffect, useState } from "react";
import { useConfirm } from "@/providers/confirm-dialog-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { PageLoader } from "@/components/shared/PageLoader";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import { Pencil, Plus, Search, X } from "lucide-react";
import { RoleForm, type RoleFormData } from "./RoleForm";
import {
  useRoles,
  useCreatePolicy,
  useUpdatePolicy,
  useUpdatePolicyPermissions,
} from "@/hooks/queries/use-policies";
import { useAppSelector } from "@/store";
import type { PolicyResponseDTO } from "@/api/org-setup/types";

const STATUS_OPTIONS = [
  { label: "All", value: "all" },
  { label: "Active", value: "active" },
  { label: "Inactive", value: "inactive" },
];

export function RolesPage() {
  const confirm = useConfirm();
  const savedOrg = useAppSelector((s) => s.organisation.savedOrganisation);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showForm, setShowForm] = useState(false);
  const [editingRole, setEditingRole] = useState<PolicyResponseDTO | null>(null);
  const [viewingRole, setViewingRole] = useState<PolicyResponseDTO | null>(null);

  useEffect(() => {
    const t = setTimeout(
      () => setDebouncedSearch(search.length >= 2 ? search : ""),
      400,
    );
    return () => clearTimeout(t);
  }, [search]);

  const isActiveFilter =
    statusFilter === "all" ? undefined : statusFilter === "active";
  const { data: rolesResp, isLoading } = useRoles({
    search: debouncedSearch,
    limit: 100,
    is_active: isActiveFilter,
  });
  const roles = rolesResp?.items ?? [];

  const createPolicy = useCreatePolicy();
  const updatePolicy = useUpdatePolicy();
  const updatePerms = useUpdatePolicyPermissions();
  const isSaving =
    createPolicy.isPending || updatePolicy.isPending || updatePerms.isPending;

  const handleSave = (data: RoleFormData) => {
    confirm({
      title: "Create Role?",
      description: "Are you sure you want to create this role?",
      confirmText: "Save",
      onConfirm: async () => {
        await createPolicy.mutateAsync({
          name: data.name,
          is_role: true,
          is_active: data.status,
          organisation_id: savedOrg?.id ?? null,
          permissions: data.permissions,
        });
        setShowForm(false);
      },
    });
  };

  const handleEdit = (role: PolicyResponseDTO) => {
    setEditingRole(role);
    setShowForm(true);
  };

  const handleEditSave = (data: RoleFormData) => {
    if (!editingRole) return;
    confirm({
      title: "Update Role?",
      description: "Are you sure you want to update this role?",
      confirmText: "Update",
      onConfirm: async () => {
        await updatePolicy.mutateAsync({
          id: editingRole.id,
          payload: { name: data.name, is_active: data.status },
        });
        await updatePerms.mutateAsync({
          id: editingRole.id,
          payload: { permissions: data.permissions },
        });
        setShowForm(false);
        setEditingRole(null);
      },
    });
  };

  const openAdd = () => {
    setEditingRole(null);
    setShowForm(true);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  if (viewingRole) {
    return (
      <RoleForm
        editingRole={viewingRole}
        onCancel={() => setViewingRole(null)}
        viewMode
        onEdit={() => {
          const role = viewingRole;
          setViewingRole(null);
          handleEdit(role);
        }}
      />
    );
  }

  if (showForm) {
    return (
      <RoleForm
        editingRole={editingRole}
        onSave={editingRole ? handleEditSave : handleSave}
        onCancel={() => {
          setShowForm(false);
          setEditingRole(null);
        }}
        isSaving={isSaving}
      />
    );
  }

  if (isLoading) return <PageLoader message="Loading roles..." />;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl">Roles</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Create roles and the permissions they grant. Assign them to employees.
          </p>
        </div>
        <Button variant="success" onClick={openAdd}>
          <Plus className="size-4" />
          Add Role
        </Button>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-icon" />
          <Input
            placeholder="Search roles..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="w-36">
          <SearchableSelect
            className="mt-0"
            options={STATUS_OPTIONS}
            value={statusFilter}
            onChange={setStatusFilter}
            placeholder="Status"
            searchable={false}
          />
        </div>
        {(search || statusFilter !== "all") && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              setStatusFilter("all");
            }}
          >
            <X />
            Clear
          </Button>
        )}
      </div>

      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead className="w-[280px]">Role Name</TableHead>
              <TableHead>Modules</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {roles.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="h-24 text-center text-muted-foreground"
                >
                  No roles found.
                </TableCell>
              </TableRow>
            ) : (
              roles.map((role) => (
                <TableRow
                  key={role.id}
                  className="cursor-pointer"
                  onClick={() => setViewingRole(role)}
                >
                  <TableCell className="font-medium">{role.name}</TableCell>
                  <TableCell>{role.module_count}</TableCell>
                  <TableCell>
                    {role.is_active ? (
                      <StatusBadge status="active" />
                    ) : (
                      <StatusBadge status="inactive" />
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleEdit(role);
                        }}
                      >
                        <Pencil className="size-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
