import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import {
  Plus,
  Search,
  Pencil,
  Trash2,
  Loader2,
  Mail,
  Info,
  Users,
} from "lucide-react";
import {
  useGetProjectHeadsQuery,
  useGetAvailableProjectHeadsQuery,
  useBulkAssignProjectHeadsMutation,
  useCreateProjectHeadMutation,
  useUpdateProjectHeadMutation,
  useDeleteProjectHeadMutation,
  useGetClientsQuery,
} from "@/store/api/timesheetApi";
import type {
  ProjectHeadResponse,
  ProjectHeadBulkAssignItem,
  EntityStatus,
} from "@/types/timesheet";
import { toast } from "@/lib/toast";
import { PageLoader } from "@/components/shared/PageLoader";
import { EmptyState } from "@/components/shared/EmptyState";
import { TablePagination } from "@/components/shared/TablePagination";
import { useUnsavedGuard } from "@/hooks/use-unsaved-guard";

const emptyForm = {
  client_id: "",
  first_name: "",
  last_name: "",
  email: "",
  phone: "",
  status: "active" as EntityStatus,
};

const ClientProjectHeads = ({
  initialFormOpen = false,
  externalFormOpen = false,
  onExternalFormOpenHandled,
}: {
  initialFormOpen?: boolean;
  externalFormOpen?: boolean;
  onExternalFormOpenHandled?: () => void;
}) => {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [search, setSearch] = useState("");
  const [clientFilter, setClientFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const [formOpen, setFormOpen] = useState(initialFormOpen);
  const [editing, setEditing] = useState<ProjectHeadResponse | null>(null);
  const [deleteConfirm, setDeleteConfirm] =
    useState<ProjectHeadResponse | null>(null);

  const [form, setForm] = useState(emptyForm);
  const [formTouched, setFormTouched] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  // Multi-select assignment. Values are prefixed `emp:` / `ext:` so one list can
  // carry both groups. Any pick means we bulk-assign instead of keying in a new
  // contact.
  const [picked, setPicked] = useState<string[]>([]);
  const hasPicks = picked.length > 0;

  useEffect(() => {
    if (externalFormOpen && !formOpen) {
      setEditing(null);
      setForm(emptyForm);
      setPicked([]);
      setFormTouched(false);
      setFormErrors({});
      setSaveError(null);
      setFormOpen(true);
      onExternalFormOpenHandled?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalFormOpen]);

  // Fetch all records for this client filter so client-side search/status
  // filtering works across the full dataset. Use server total on first load
  // to avoid a hard cap; fall back to 500 until total is known.
  const { data: countData } = useGetProjectHeadsQuery({
    client_id: clientFilter !== "all" ? clientFilter : undefined,
    page: 1,
    page_size: 1,
  });
  const serverTotal = countData?.total ?? 500;
  const { data, isLoading } = useGetProjectHeadsQuery({
    client_id: clientFilter !== "all" ? clientFilter : undefined,
    page: 1,
    page_size: Math.max(serverTotal, 1),
  });
  // Picker source: people assignable to the CURRENTLY selected client. The BE
  // dedupes by person and excludes anyone already heading that client, so this
  // re-fetches whenever the client dropdown changes.
  const { data: availableData } = useGetAvailableProjectHeadsQuery(
    { client_id: form.client_id },
    { skip: !form.client_id },
  );
  const { data: clientsData } = useGetClientsQuery({
    page: 1,
    page_size: 200,
    status: "active",
  });
  const [createProjectHead, { isLoading: isCreating }] =
    useCreateProjectHeadMutation();
  const [bulkAssignProjectHeads, { isLoading: isAssigning }] =
    useBulkAssignProjectHeadsMutation();
  const [updateProjectHead, { isLoading: isUpdating }] =
    useUpdateProjectHeadMutation();
  const [deleteProjectHead] = useDeleteProjectHeadMutation();

  const clients = clientsData?.items ?? [];
  const clientMap = new Map(clients.map((c) => [c.id, c.name]));

  const allHeads = data?.items ?? [];

  // The BE returns two groups (already scoped + deduped, excluding anyone who
  // already heads this client). They share ONE dropdown, split by group header.
  // Values are prefixed so the two id spaces can't collide.
  const availEmployees = availableData?.employees ?? [];
  const availExternal = availableData?.external_heads ?? [];

  const assignableOptions = [
    ...availEmployees.map((e) => ({
      label: `${e.first_name} ${e.last_name} · ${e.emp_code} — ${e.department_name}`,
      value: `emp:${e.user_id}`,
      group: "Employees",
    })),
    ...availExternal.map((h) => ({
      label: `${h.first_name} ${h.last_name} (${h.email})`,
      value: `ext:${h.id}`,
      group: "External Project Heads",
    })),
  ];

  const filtered = allHeads.filter((h) => {
    const matchesSearch =
      !search ||
      `${h.first_name} ${h.last_name}`
        .toLowerCase()
        .includes(search.toLowerCase()) ||
      h.email.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === "all" || h.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const paginated = filtered.slice((page - 1) * pageSize, page * pageSize);

  useEffect(() => {
    setPage(1);
  }, [search, clientFilter, statusFilter]);

  const clearPicks = () => setPicked([]);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    clearPicks();
    setFormErrors({});
    setSaveError(null);
    setFormTouched(false);
    setFormOpen(true);
  };

  const openEdit = (head: ProjectHeadResponse) => {
    setEditing(head);
    clearPicks();
    setForm({
      client_id: head.client_id,
      first_name: head.first_name,
      last_name: head.last_name,
      email: head.email,
      phone: head.phone ?? "",
      status: head.status,
    });
    setFormErrors({});
    setSaveError(null);
    setFormTouched(false);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
    clearPicks();
    setFormTouched(false);
  };

  const validate = () => {
    const errs: Record<string, string> = {};
    if (!editing && !form.client_id) errs.client_id = "Client is required";
    // Assigning existing people — the manual contact fields aren't in play.
    if (!editing && hasPicks) {
      setFormErrors(errs);
      return Object.keys(errs).length === 0;
    }
    if (!form.first_name.trim()) errs.first_name = "First name is required";
    if (!form.last_name.trim()) errs.last_name = "Last name is required";
    if (!form.email.trim()) errs.email = "Email is required";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()))
      errs.email = "Enter a valid email";
    setFormErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;
    setSaveError(null);
    try {
      if (editing) {
        await updateProjectHead({
          id: editing.id,
          body: {
            first_name: form.first_name.trim(),
            last_name: form.last_name.trim(),
            email: form.email.trim(),
            phone: form.phone.trim() || null,
            status: form.status,
          },
        }).unwrap();
      } else if (hasPicks) {
        // Employees and external heads expose the same fields, so they go into
        // one uniform array — no branching on the wire.
        const pickedEmployeeIds = picked
          .filter((v) => v.startsWith("emp:"))
          .map((v) => v.slice(4));
        const pickedExternalIds = picked
          .filter((v) => v.startsWith("ext:"))
          .map((v) => v.slice(4));
        const heads: ProjectHeadBulkAssignItem[] = [
          ...availEmployees
            .filter((e) => pickedEmployeeIds.includes(e.user_id))
            .map((e) => ({
              first_name: e.first_name,
              last_name: e.last_name,
              email: e.email,
              phone: null,
            })),
          ...availExternal
            .filter((h) => pickedExternalIds.includes(h.id))
            .map((h) => ({
              first_name: h.first_name,
              last_name: h.last_name,
              email: h.email,
              phone: h.phone ?? null,
            })),
        ];
        const res = await bulkAssignProjectHeads({
          client_id: form.client_id,
          heads,
        }).unwrap();
        toast.success(
          `${res.total_created} project head${res.total_created === 1 ? "" : "s"} assigned`,
          res.total_skipped > 0
            ? `${res.total_skipped} already assigned to this client and skipped.`
            : undefined,
        );
      } else {
        await createProjectHead({
          client_id: form.client_id,
          first_name: form.first_name.trim(),
          last_name: form.last_name.trim(),
          email: form.email.trim(),
          phone: form.phone.trim() || null,
        }).unwrap();
      }
      closeForm();
    } catch (err: unknown) {
      const e = err as { data?: { detail?: unknown }; status?: number };
      const detail = e?.data?.detail;
      if (typeof detail === "string") setSaveError(detail);
      else if (e?.status === 409)
        setSaveError("A project head with this email already exists");
      else setSaveError("Failed to save. Please try again.");
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    try {
      await deleteProjectHead(deleteConfirm.id).unwrap();
      toast.success("Project head removed");
      setDeleteConfirm(null);
    } catch (err) {
      toast.error(err, "Failed to remove project head");
    }
  };

  const getInitials = (first: string, last: string) =>
    `${first[0] ?? ""}${last[0] ?? ""}`.toUpperCase();

  // Any pick blanks the manual fields (they're locked while assigning existing
  // people); clearing every pick frees them again.
  const pickHeads = (ids: string[]) => {
    setPicked(ids);
    if (ids.length > 0) {
      setForm((prev) => ({
        ...prev,
        first_name: "",
        last_name: "",
        email: "",
        phone: "",
      }));
      setFormErrors({});
    }
    setFormTouched(true);
  };

  const updateForm = (field: string, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    // Switching client invalidates the picks (the available list is per-client).
    if (field === "client_id") setPicked([]);
    setFormTouched(true);
  };

  const guardedFormOpenChange = useUnsavedGuard(formTouched, (open) => {
    if (!open) closeForm();
  });

  return (
    <>
      <div className="rounded-xl border overflow-x-auto bg-card">
        {/* Toolbar */}
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search by name or email"
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <Select value={clientFilter} onValueChange={setClientFilter}>
            <SelectTrigger className="w-44">
              <SelectValue placeholder="All Clients" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Clients</SelectItem>
              {clients.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex-1" />

          <Button onClick={openCreate}>
            <Plus />
            Add Project Head
          </Button>
        </div>

        {/* Table */}
        {isLoading ? (
          <PageLoader message="Loading project heads…" />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No project heads found"
            description="Add a project head to get started."
            action={
              <Button onClick={openCreate}>
                <Plus />
                Add Project Head
              </Button>
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 min-w-[180px]">
                      Name
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 min-w-[140px]">
                      Client
                    </TableHead>
                    <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 min-w-[180px]">
                      Email
                    </TableHead>
                    <TableHead className="w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginated.map((head) => (
                    <TableRow key={head.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <Avatar className="h-9 w-9 shrink-0">
                            <AvatarFallback className="bg-primary/10 text-primary text-xs font-semibold">
                              {getInitials(head.first_name, head.last_name)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="font-medium text-foreground truncate">
                            {head.first_name} {head.last_name}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {clientMap.get(head.client_id) ?? "-"}
                      </TableCell>
                      <TableCell>
                        <span className="flex items-center gap-1.5 text-muted-foreground">
                          <Mail className="size-3.5 shrink-0" />
                          <span className="truncate">{head.email}</span>
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            onClick={() => openEdit(head)}
                          >
                            <Pencil />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            onClick={() => setDeleteConfirm(head)}
                          >
                            <Trash2 className="size-4 text-destructive" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <TablePagination
              currentPage={page}
              totalPages={totalPages}
              startIndex={total === 0 ? 0 : (page - 1) * pageSize + 1}
              endIndex={Math.min(page * pageSize, total)}
              total={total}
              pageSize={pageSize}
              onPageChange={setPage}
              onPageSizeChange={(s) => {
                setPageSize(s);
                setPage(1);
              }}
            />
          </>
        )}
      </div>

      {/* Create / Edit Sheet */}
      <Sheet open={formOpen} onOpenChange={guardedFormOpenChange}>
        <SheetContent className="w-[480px] sm:max-w-[520px] flex flex-col p-0">
          <SheetHeader className="px-6 py-5 border-b">
            <SheetTitle>
              {editing ? "Edit Project Head" : "Add Project Head"}
            </SheetTitle>
            <SheetDescription>
              {editing
                ? "Update the project head's details."
                : "Create a new project head contact for a client."}
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
            {/* Client — only on create */}
            {!editing && (
              <div className="space-y-2">
                <Label>
                  Client <span className="text-destructive">*</span>
                </Label>
                <Select
                  value={form.client_id}
                  onValueChange={(v) => updateForm("client_id", v)}
                >
                  <SelectTrigger
                    className={formErrors.client_id ? "border-destructive" : ""}
                  >
                    <SelectValue placeholder="Select client" />
                  </SelectTrigger>
                  <SelectContent>
                    {clients.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {formErrors.client_id && (
                  <p className="text-xs text-destructive">
                    {formErrors.client_id}
                  </p>
                )}
              </div>
            )}

            {/* Assign existing people — create only. One dropdown, grouped into
                Employees / External Project Heads. */}
            {!editing && (
              <>
                <div className="space-y-2">
                  <Label>Assign Existing Project Heads</Label>
                  <SearchableSelect
                    multi
                    options={assignableOptions}
                    value={picked}
                    onChange={(v) => pickHeads(v as string[])}
                    placeholder={
                      !form.client_id
                        ? "Select a client first"
                        : assignableOptions.length === 0
                          ? "No one available for this client"
                          : "Select employees or project heads"
                    }
                    disabled={!form.client_id || assignableOptions.length === 0}
                  />
                </div>

                {/* OR separator */}
                <div className="flex items-center gap-3">
                  <div className="h-px flex-1 bg-border" />
                  <span className="text-xs font-medium text-muted-foreground">
                    OR
                  </span>
                  <div className="h-px flex-1 bg-border" />
                </div>
              </>
            )}

            {/* Project head details — locked & autofilled when assigning an existing head */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>
                  First Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  value={form.first_name}
                  onChange={(e) => updateForm("first_name", e.target.value)}
                  disabled={hasPicks}
                  className={formErrors.first_name ? "border-destructive" : ""}
                />
                {formErrors.first_name && (
                  <p className="text-xs text-destructive">
                    {formErrors.first_name}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label>
                  Last Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  value={form.last_name}
                  onChange={(e) => updateForm("last_name", e.target.value)}
                  disabled={hasPicks}
                  className={formErrors.last_name ? "border-destructive" : ""}
                />
                {formErrors.last_name && (
                  <p className="text-xs text-destructive">
                    {formErrors.last_name}
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <Label>
                Email <span className="text-destructive">*</span>
              </Label>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => updateForm("email", e.target.value)}
                disabled={hasPicks}
                className={formErrors.email ? "border-destructive" : ""}
              />
              {formErrors.email && (
                <p className="text-xs text-destructive">{formErrors.email}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label>
                Phone{" "}
                <span className="text-xs text-muted-foreground">
                  (optional)
                </span>
              </Label>
              <Input
                value={form.phone}
                onChange={(e) =>
                  updateForm(
                    "phone",
                    e.target.value.replace(/[^\d+\s\-().]/g, ""),
                  )
                }
                maxLength={20}
                placeholder="+91-9876543210"
                disabled={hasPicks}
              />
            </div>

            {editing && (
              <div className="flex items-center gap-3">
                <Label className="min-w-fit">Status</Label>
                <Select
                  value={form.status}
                  onValueChange={(v) => updateForm("status", v)}
                >
                  <SelectTrigger className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Only a NEW person gets an IAM account + activation email; an
                existing head already has a login, so no email goes out. */}
            {!editing && !hasPicks && (
              <div className="flex items-start gap-2 rounded-md bg-muted border px-3 py-2 text-xs text-muted-foreground">
                <Info className="size-3.5 mt-0.5 shrink-0" />
                An activation link will be sent to the email provided for login.
              </div>
            )}

            {saveError && (
              <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-sm text-destructive">
                {saveError}
              </div>
            )}
          </div>

          <div className="border-t px-6 py-4 flex items-center justify-between">
            <Button
              variant="outline"
              onClick={() => guardedFormOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={isCreating || isUpdating || isAssigning}
            >
              {(isCreating || isUpdating || isAssigning) && (
                <Loader2 className="animate-spin" />
              )}
              Save
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* Delete Confirmation */}
      <Dialog
        open={!!deleteConfirm}
        onOpenChange={() => setDeleteConfirm(null)}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Project Head</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete{" "}
            <strong>
              {deleteConfirm?.first_name} {deleteConfirm?.last_name}
            </strong>
            ? This action cannot be undone.
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" autoFocus>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="outline"
              className="text-destructive border-destructive hover:bg-destructive/10"
              onClick={handleDelete}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default ClientProjectHeads;
