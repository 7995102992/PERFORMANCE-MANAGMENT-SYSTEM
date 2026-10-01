import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Plus,
  Search,
  Upload,
  Download,
  Pencil,
  Trash2,
  Loader2,
  Phone,
  FileSpreadsheet,
  AlertCircle,
  Users,
  Building2,
  UserCog,
} from "lucide-react";
import {
  useGetClientsQuery,
  useDeleteClientMutation,
  useImportClientsMutation,
  useValidateClientsMutation,
} from "@/store/api/timesheetApi";
import type { ValidateResponse } from "@/store/api/timesheetApi";
import { useGetBusinessUnitsQuery, useGetDepartmentsQuery } from "@/store/api/iamApi";
import type { ClientResponse } from "@/types/timesheet";
import ClientProjectHeads from "./ClientProjectHeads";
import ClientSheet from "./ClientSheet";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { FileDropZone } from "@/components/shared/FileDropZone";
import { EmptyState } from "@/components/shared/EmptyState";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { TablePagination } from "@/components/shared/TablePagination";
import { toast } from "@/lib/toast";
import { downloadAuthed } from "@/lib/download";
import { BulkImportDialog } from "@/components/shared/BulkImportDialog";
import type { BulkImportResult } from "@/components/shared/BulkImportDialog";

const TIMESHEET_BASE_URL = import.meta.env.VITE_TIMESHEET_BASE_URL as string;

const Clients = () => {
  const [activeTab, setActiveTab] = useState("clients");
  const [page, setPage] = useState(1);
  const [clientSheetOpen, setClientSheetOpen] = useState(false);
  const [editClientId, setEditClientId] = useState<string | undefined>(
    undefined,
  );
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [pageSize, setPageSize] = useState(10);
  const [deleteConfirm, setDeleteConfirm] = useState<ClientResponse | null>(
    null,
  );
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [addPHPrompt, setAddPHPrompt] = useState(false);
  const [openPHSheet, setOpenPHSheet] = useState(false);

  const { data, isLoading } = useGetClientsQuery({
    page,
    page_size: pageSize,
    q: search || undefined,
    status: statusFilter,
  });
  const [deleteClient] = useDeleteClientMutation();
  const [importClients, { isLoading: isImporting }] =
    useImportClientsMutation();
  const [validateClients, { isLoading: isValidating }] =
    useValidateClientsMutation();

  const clients = data?.items ?? [];
  const total = data?.total ?? 0;

  // Resolve business-unit / department ids → names for the list column
  const { data: businessUnits = [] } = useGetBusinessUnitsQuery({ limit: 100 });
  const { data: departments = [] } = useGetDepartmentsQuery({ limit: 100 });
  const belongsToMap = useMemo(() => {
    const map = new Map<string, string>();
    businessUnits.forEach((b) => map.set(b.id, b.business_unit_name));
    departments.forEach((d) => map.set(d.id, d.departmentName));
    return map;
  }, [businessUnits, departments]);

  const resolveNames = (
    ids: string[] | null | undefined,
    names: string[] | null | undefined,
  ): string[] => {
    if (names && names.length > 0) return names;
    return (ids ?? []).map((id) => belongsToMap.get(id) ?? "—");
  };

  const getBelongsTo = (c: ClientResponse) => {
    const buNames = resolveNames(c.business_unit_ids, c.business_unit_names);
    const deptNames = resolveNames(c.department_ids, c.department_names);
    return { buNames, deptNames };
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    try {
      await deleteClient(deleteConfirm.id).unwrap();
      toast.success("Client deleted");
      setDeleteConfirm(null);
    } catch (err) {
      toast.error(err, "Failed to delete client");
    }
  };

  const getInitials = (name: string) => {
    return name
      .split(" ")
      .map((w) => w[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  const handleDownloadTemplate = async () => {
    try {
      await downloadAuthed(
        `${TIMESHEET_BASE_URL}clients/template`,
        "client_import_template.xlsx",
      );
    } catch (err) {
      toast.error(err, "Couldn't download the template. Please try again.");
    }
  };

  const handleValidateClients = async (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    return validateClients(formData).unwrap();
  };

  const handleImportClients = async (file: File): Promise<BulkImportResult> => {
    const formData = new FormData();
    formData.append("file", file);
    return importClients(formData).unwrap() as Promise<BulkImportResult>;
  };

  const handleExport = async () => {
    setIsExporting(true);
    try {
      await downloadAuthed(
        `${TIMESHEET_BASE_URL}clients/export`,
        `clients_export_${new Date().toISOString().slice(0, 10)}.xlsx`,
      );
      setExportOpen(false);
    } catch (err) {
      toast.error(err, "Export failed. Please try again.");
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Timesheet – Client"
        subtitle="Manage and add client timesheets"
        action={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <Download />
              Import Clients
            </Button>
            <Button variant="outline" onClick={() => setExportOpen(true)}>
              <Upload />
              Export Data
            </Button>
            <Button
              onClick={() => {
                setEditClientId(undefined);
                setClientSheetOpen(true);
              }}
            >
              <Plus />
              Add Client
            </Button>
          </div>
        }
      />

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="clients" className="gap-2">
            <Building2 className="size-4" />
            Clients
          </TabsTrigger>
          <TabsTrigger value="project-heads" className="gap-2">
            <UserCog className="size-4" />
            Project Heads
          </TabsTrigger>
        </TabsList>

        {/* ── Clients Tab ── */}
        <TabsContent value="clients" className="mt-4">
          <div className="rounded-xl border overflow-x-auto bg-card">
            {/* Toolbar */}
            <div className="flex items-center gap-3 border-b px-4 py-3">
              <div className="relative flex-1 max-w-sm">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
                <Input
                  placeholder="Search Clients"
                  className="pl-9"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                />
              </div>
              <Select
                value={statusFilter}
                onValueChange={(v) => {
                  setStatusFilter(v);
                  setPage(1);
                }}
              >
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="All Clients" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Clients</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Table */}
            {isLoading ? (
              <PageLoader message="Loading clients…" />
            ) : clients.length === 0 ? (
              <EmptyState
                icon={Users}
                title={
                  search || statusFilter !== "all"
                    ? "No clients found"
                    : "No clients available to you"
                }
                description={
                  search || statusFilter !== "all"
                    ? "No clients match the current filters."
                    : // Scoped to the caller: non-admins only see clients behind
                      // their own projects, plus any client they created.
                      "You'll see a client here once you're on one of its projects, or once you create one yourself."
                }
                action={
                  <Button
                    onClick={() => {
                      setEditClientId(undefined);
                      setClientSheetOpen(true);
                    }}
                  >
                    <Plus />
                    Add Client
                  </Button>
                }
              />
            ) : (
              <>
                <div className="w-full">
                  <Table className="table-fixed w-full">
                    <TableHeader>
                      <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                        <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 w-[20%]">
                          Client
                        </TableHead>
                        <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 w-[13%]">
                          Point Of Contact
                        </TableHead>
                        <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 w-[17%]">
                          Email
                        </TableHead>
                        <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 w-[13%]">
                          Phone
                        </TableHead>
                        <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 w-[20%] truncate" title="Business Units / Departments">
                          BU / Dept
                        </TableHead>
                        <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10 w-[10%]">
                          Status
                        </TableHead>
                        <TableHead className="w-[84px]" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {clients.map((client) => (
                        <TableRow key={client.id}>
                          <TableCell className="align-middle">
                            <div className="flex items-center gap-3 min-w-0">
                              <Avatar className="h-9 w-9 shrink-0">
                                <AvatarFallback className="bg-primary/10 text-primary text-xs font-semibold">
                                  {getInitials(client.name)}
                                </AvatarFallback>
                              </Avatar>
                              <div className="min-w-0">
                                <div className="font-medium text-foreground truncate" title={client.name}>
                                  {client.name}
                                </div>
                                {client.address && (
                                  <div className="text-xs text-muted-foreground truncate" title={client.address}>
                                    {client.address}
                                  </div>
                                )}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground truncate" title={client.contact_person ?? undefined}>
                            {client.contact_person ?? "-"}
                          </TableCell>
                          <TableCell className="text-muted-foreground truncate" title={client.contact_email ?? undefined}>
                            {client.contact_email ?? "-"}
                          </TableCell>
                          <TableCell className="truncate">
                            {client.contact_phone ? (
                              <span className="flex items-center gap-1.5 text-muted-foreground truncate">
                                <Phone className="size-3.5 shrink-0" />
                                <span className="truncate">{client.contact_phone}</span>
                              </span>
                            ) : (
                              "-"
                            )}
                          </TableCell>
                          <TableCell>
                            {(() => {
                              const { buNames, deptNames } = getBelongsTo(client);
                              if (buNames.length === 0 && deptNames.length === 0)
                                return <span className="text-muted-foreground">-</span>;
                              return (
                                <div className="min-w-0 space-y-0.5">
                                  {buNames.length > 0 && (
                                    <div className="text-sm text-foreground truncate" title={buNames.join(", ")}>
                                      <span className="text-xs text-muted-foreground">BU: </span>
                                      {buNames.join(", ")}
                                    </div>
                                  )}
                                  {deptNames.length > 0 && (
                                    <div className="text-sm text-foreground truncate" title={deptNames.join(", ")}>
                                      <span className="text-xs text-muted-foreground">Dept: </span>
                                      {deptNames.join(", ")}
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                          </TableCell>
                          <TableCell>
                            <StatusBadge
                              status={
                                client.status === "active"
                                  ? "active"
                                  : "inactive"
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-8"
                                onClick={() => {
                                  setEditClientId(client.id);
                                  setClientSheetOpen(true);
                                }}
                              >
                                <Pencil />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-8"
                                onClick={() => setDeleteConfirm(client)}
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
                  totalPages={Math.ceil(total / pageSize)}
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
        </TabsContent>

        {/* ── Project Heads Tab ── */}
        <TabsContent value="project-heads" className="mt-4">
          <ClientProjectHeads
            externalFormOpen={openPHSheet}
            onExternalFormOpenHandled={() => setOpenPHSheet(false)}
          />
        </TabsContent>
      </Tabs>

      {/* Delete Confirmation */}
      <Dialog
        open={!!deleteConfirm}
        onOpenChange={() => setDeleteConfirm(null)}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Client</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete{" "}
            <strong>{deleteConfirm?.name}</strong>? This action cannot be
            undone.
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
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

      {/* Export Dialog */}
      <Dialog
        open={exportOpen}
        onOpenChange={(o) => !isExporting && setExportOpen(o)}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Export Client List</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Download the full client list as an Excel file.
            {total > 0 && (
              <>
                {" "}
                <span className="font-medium">{total} clients</span> will be
                exported.
              </>
            )}
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={isExporting}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              onClick={handleExport}
              disabled={isExporting}
            >
              {isExporting ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Download />
              )}
              {isExporting ? "Exporting..." : "Download Excel"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BulkImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        entityName="Clients"
        templateLabel="Client Template"
        templateDescription="Fill in client name, contact details, and country"
        buildSections={(result) => [
          {
            label: "",
            rows: result.rows,
            total: result.total,
            columns: [
              { key: "name", label: "Client Name" },
              { key: "business_units", label: "Business Units" },
              { key: "departments", label: "Departments" },
            ],
          },
        ]}
        onDownloadTemplate={handleDownloadTemplate}
        onValidate={handleValidateClients}
        onImport={handleImportClients}
      />

      <ClientSheet
        open={clientSheetOpen}
        onOpenChange={setClientSheetOpen}
        clientId={editClientId}
        onCreated={() => setAddPHPrompt(true)}
      />

      <Dialog open={addPHPrompt} onOpenChange={setAddPHPrompt}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Add a project head?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Would you like to add a project head for this client now?
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddPHPrompt(false)}>
              Skip
            </Button>
            <Button
              autoFocus
              onClick={() => {
                setAddPHPrompt(false);
                setActiveTab("project-heads");
                setOpenPHSheet(true);
              }}
            >
              Add Project Head
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Clients;
