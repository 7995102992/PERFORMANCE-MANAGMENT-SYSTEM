import { useMemo, useState } from "react";
import { useConfirm } from "@/providers/confirm-dialog-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/shared/StatusBadge";
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
import { PayGradeDialog } from "./PayGradeDialog";
import {
  usePayGrades,
  useCreatePayGrade,
  useUpdatePayGrade,
} from "@/hooks/queries/use-paygrades";
import { useBands } from "@/hooks/queries/use-bands";
import { useAppSelector } from "@/store";
import type { PayGrade } from "@/modules/org-setup/types/paygrade";
import type { PayGradeResponseDTO } from "@/api/org-setup/types";

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_FILTER_OPTIONS = [
  { label: "All", value: "all" },
  { label: "Active", value: "active" },
  { label: "Inactive", value: "inactive" },
];

const ADD_ACTION_BUTTON_CLASS = "border-border text-foreground hover:bg-muted";

// ─── Component ────────────────────────────────────────────────────────────────

export function PayGradesPage() {
  const confirm = useConfirm();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingPayGrade, setEditingPayGrade] = useState<PayGrade | null>(null);
  const [viewingPayGrade, setViewingPayGrade] = useState<PayGrade | null>(null);

  // API data
  const savedOrg = useAppSelector((s) => s.organisation.savedOrganisation);
  const { data: payGrades = [], isLoading } = usePayGrades(savedOrg?.id);
  const createPayGrade = useCreatePayGrade();
  const updatePayGrade = useUpdatePayGrade();

  // Fetch bands for the dialog dropdown
  const { data: remoteBands = [] } = useBands(savedOrg?.id);

  const bandOptions = useMemo(
    () =>
      remoteBands
        .filter((b) => b.is_active)
        .map((b) => ({ label: b.name, value: b.id })),
    [remoteBands],
  );

  // ── Filtering & pagination ────────────────────────────────────────────────

  const filtered = useMemo(() => {
    return payGrades.filter((pg) => {
      const matchesSearch =
        !search ||
        pg.name.toLowerCase().includes(search.toLowerCase()) ||
        (pg.description ?? "").toLowerCase().includes(search.toLowerCase()) ||
        pg.bandNames.some((bn) =>
          bn.toLowerCase().includes(search.toLowerCase()),
        );
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "active" && pg.is_active) ||
        (statusFilter === "inactive" && !pg.is_active);
      return matchesSearch && matchesStatus;
    });
  }, [payGrades, search, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const paginated = filtered.slice(
    (safePage - 1) * pageSize,
    safePage * pageSize,
  );
  const startIndex = filtered.length === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const endIndex = Math.min(safePage * pageSize, filtered.length);

  function handleSearchChange(value: string) {
    setSearch(value);
    setCurrentPage(1);
  }
  function handleStatusChange(value: string) {
    setStatusFilter(value);
    setCurrentPage(1);
  }
  function resetFilters() {
    setSearch("");
    setStatusFilter("all");
    setCurrentPage(1);
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  function openAdd() {
    setEditingPayGrade(null);
    setDialogOpen(true);
  }

  function openEdit(pg: PayGradeResponseDTO) {
    setEditingPayGrade({
      id: pg.id,
      name: pg.name,
      description: pg.description ?? "",
      bandIds: pg.bandIds,
      bandNames: pg.bandNames,
      is_active: pg.is_active,
    });
    setDialogOpen(true);
  }

  function handleSave(pg: PayGrade) {
    if (editingPayGrade) {
      // Update
      confirm({
        title: "Update Pay Grade?",
        description: "Are you sure you want to update this pay grade?",
        confirmText: "Update",
        onConfirm: async () => {
          await updatePayGrade.mutateAsync({
            id: editingPayGrade.id,
            payload: {
              name: pg.name,
              description: pg.description || null,
              bandIds: pg.bandIds,
              is_active: pg.is_active,
            },
          });
          setDialogOpen(false);
          setEditingPayGrade(null);
        },
      });
    } else {
      // Create
      if (!savedOrg?.id) return;
      confirm({
        title: "Create Pay Grade?",
        description: "Are you sure you want to create this pay grade?",
        confirmText: "Save",
        onConfirm: async () => {
          await createPayGrade.mutateAsync({
            name: pg.name,
            description: pg.description || null,
            bandIds: pg.bandIds,
            is_active: pg.is_active,
          });
          setDialogOpen(false);
          setEditingPayGrade(null);
        },
      });
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl">Pay Grades</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Set up pay grades linked to bands.
          </p>
        </div>
        <Button variant="success" onClick={openAdd}>
          <Plus className="size-4" />
          Add Pay Grade
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-icon" />
          <Input
            placeholder="Search pay grades..."
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="w-48">
          <SearchableSelect
            options={STATUS_FILTER_OPTIONS}
            value={statusFilter}
            onChange={handleStatusChange}
            placeholder="Status"
            searchable={false}
          />
        </div>
        {(search || statusFilter !== "all") && (
          <Button variant="ghost" size="sm" onClick={resetFilters}>
            <X />
            Clear
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead className="w-[160px]">Name</TableHead>
              <TableHead>Band</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="h-24 text-center text-muted-foreground"
                >
                  Loading pay grades...
                </TableCell>
              </TableRow>
            ) : paginated.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="h-24 text-center text-muted-foreground"
                >
                  No pay grades found.
                </TableCell>
              </TableRow>
            ) : (
              paginated.map((pg) => (
                <TableRow
                  key={pg.id}
                  className="cursor-pointer"
                  onClick={() => {
                    setViewingPayGrade({
                      id: pg.id,
                      name: pg.name,
                      description: pg.description ?? "",
                      bandIds: pg.bandIds,
                      bandNames: pg.bandNames,
                      is_active: pg.is_active,
                    });
                  }}
                >
                  <TableCell className="font-medium">{pg.name}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {pg.bandNames.map((bn, i) => (
                        <Badge key={i} variant="outline">
                          {bn}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    {pg.is_active ? (
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
                          openEdit(pg);
                        }}
                        title="Edit"
                      >
                        <Pencil className="size-4" />
                      </Button>
                      {/* <Button variant="ghost" size="icon" className="size-8 text-destructive hover:text-destructive" onClick={() => handleDelete(pg)} title="Delete">
                        <Trash2 className="size-4" />
                      </Button> */}
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
        total={filtered.length}
        pageSize={pageSize}
        onPageChange={setCurrentPage}
        onPageSizeChange={(s) => {
          setPageSize(s);
          setCurrentPage(1);
        }}
      />

      {/* Dialog */}
      <PayGradeDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditingPayGrade(null);
        }}
        editingPayGrade={editingPayGrade}
        onSave={handleSave}
        bandOptions={bandOptions}
      />

      {viewingPayGrade && (
        <PayGradeDialog
          open={!!viewingPayGrade}
          onOpenChange={(open) => {
            if (!open) setViewingPayGrade(null);
          }}
          editingPayGrade={viewingPayGrade}
          bandOptions={bandOptions}
          viewMode
          onEdit={() => {
            setEditingPayGrade(viewingPayGrade);
            setViewingPayGrade(null);
            setDialogOpen(true);
          }}
        />
      )}
    </div>
  );
}
