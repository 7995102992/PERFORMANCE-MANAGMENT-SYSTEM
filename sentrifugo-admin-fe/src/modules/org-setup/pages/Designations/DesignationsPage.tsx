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
import { TablePagination } from "@/components/shared/TablePagination";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import { Pencil, Plus, Search, X } from "lucide-react";
import { DesignationForm, type DesignationFormData } from "./DesignationForm";
import {
  useDesignations,
  useCreateDesignation,
  useUpdateDesignation,
  useDeleteDesignation,
} from "@/hooks/queries/use-designations";
import { useAppSelector } from "@/store";
import type { DesignationResponseDTO } from "@/api/org-setup/types";

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_OPTIONS = [
  { label: "All", value: "all" },
  { label: "Active", value: "active" },
  { label: "Inactive", value: "inactive" },
];

const ADD_ACTION_BUTTON_CLASS = "border-border text-foreground hover:bg-muted";

// ─── Component ────────────────────────────────────────────────────────────────

export function DesignationsPage() {
  const confirm = useConfirm();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [sheetMode, setSheetMode] = useState<"add" | "edit" | "view" | null>(
    null,
  );
  const [activeDesignation, setActiveDesignation] =
    useState<DesignationResponseDTO | null>(null);

  // Debounce search — 400ms delay, min 2 chars
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search.length >= 2 ? search : "");
      setCurrentPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  // API data
  const savedOrg = useAppSelector((s) => s.organisation.savedOrganisation);
  const isActiveFilter =
    statusFilter === "all" ? undefined : statusFilter === "active";
  const { data: designations = [], isLoading } = useDesignations(savedOrg?.id, {
    search: debouncedSearch,
    limit: 100,
    is_active: isActiveFilter,
  });
  const createDesg = useCreateDesignation();
  const updateDesg = useUpdateDesignation();
  const deleteDesg = useDeleteDesignation();

  // ── Handlers ──────────────────────────────────────────────────────────────

  const closeSheet = () => {
    setSheetMode(null);
    setActiveDesignation(null);
  };

  const handleSave = (data: DesignationFormData) => {
    confirm({
      title: "Create Designation?",
      description: "Are you sure you want to create this designation?",
      confirmText: "Save",
      onConfirm: async () => {
        await createDesg.mutateAsync({
          designationName: data.designationName,
          description: data.description,
          payGradeIds: data.payGradeIds,
          is_active: data.status,
        });
        closeSheet();
      },
    });
  };

  const handleEdit = (desg: DesignationResponseDTO) => {
    setActiveDesignation(desg);
    setSheetMode("edit");
  };

  const handleEditSave = (data: DesignationFormData) => {
    if (!activeDesignation) return;
    confirm({
      title: "Update Designation?",
      description: "Are you sure you want to update this designation?",
      confirmText: "Update",
      onConfirm: async () => {
        await updateDesg.mutateAsync({
          id: activeDesignation.id,
          payload: {
            designationName: data.designationName,
            description: data.description,
            payGradeIds: data.payGradeIds,
            is_active: data.status,
          },
        });
        closeSheet();
      },
    });
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleDelete = (desg: DesignationResponseDTO) => {
    confirm({
      title: "Delete Designation?",
      description: `Are you sure you want to delete "${desg.designationName}"? This action cannot be undone.`,
      confirmText: "Delete",
      variant: "destructive",
      onConfirm: async () => {
        await deleteDesg.mutateAsync(desg.id);
      },
    });
  };

  const openAdd = () => {
    setActiveDesignation(null);
    setSheetMode("add");
  };

  // ── Filtering ─────────────────────────────────────────────────────────────

  // Status filter (client-side — search is already handled by the BE)
  const totalPages = Math.max(1, Math.ceil(designations.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const paginated = designations.slice(
    (safePage - 1) * pageSize,
    safePage * pageSize,
  );
  const startIndex =
    designations.length === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const endIndex = Math.min(safePage * pageSize, designations.length);

  // ── Render ────────────────────────────────────────────────────────────────

  if (isLoading) return <PageLoader message="Loading designations..." />;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl">Designations</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Create job titles and their roles.
          </p>
        </div>
        <Button variant="success" onClick={openAdd}>
          <Plus className="size-4" />
          Add Designation
        </Button>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-icon" />
          <Input
            placeholder="Search designations..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setCurrentPage(1);
            }}
            className="pl-9"
          />
        </div>
        <div className="w-36">
          <SearchableSelect
            className="mt-0"
            options={STATUS_OPTIONS}
            value={statusFilter}
            onChange={(v) => {
              setStatusFilter(v);
              setCurrentPage(1);
            }}
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
              setCurrentPage(1);
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
              <TableHead className="w-[250px]">Designation Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell
                  colSpan={3}
                  className="h-24 text-center text-muted-foreground"
                >
                  Loading designations...
                </TableCell>
              </TableRow>
            ) : paginated.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={3}
                  className="h-24 text-center text-muted-foreground"
                >
                  No designations found.
                </TableCell>
              </TableRow>
            ) : (
              paginated.map((desg) => (
                <TableRow
                  key={desg.id}
                  className="cursor-pointer"
                  onClick={() => {
                    setActiveDesignation(desg);
                    setSheetMode("view");
                  }}
                >
                  <TableCell className="font-medium">
                    {desg.designationName}
                  </TableCell>
                  <TableCell>
                    {desg.is_active ? (
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
                          handleEdit(desg);
                        }}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      {/* <Button variant="ghost" size="icon" className="size-8 text-destructive hover:text-destructive" onClick={() => handleDelete(desg)}><Trash2 className="size-4" /></Button> */}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <TablePagination
        currentPage={safePage}
        totalPages={totalPages}
        startIndex={startIndex}
        endIndex={endIndex}
        total={designations.length}
        pageSize={pageSize}
        onPageChange={setCurrentPage}
        onPageSizeChange={(s) => {
          setPageSize(s);
          setCurrentPage(1);
        }}
      />

      <DesignationForm
        open={sheetMode !== null}
        onOpenChange={(o) => {
          if (!o) closeSheet();
        }}
        mode={sheetMode ?? "add"}
        editingDesignation={activeDesignation}
        onSave={sheetMode === "edit" ? handleEditSave : handleSave}
        onEdit={() => setSheetMode("edit")}
        isSaving={createDesg.isPending || updateDesg.isPending}
      />
    </div>
  );
}
