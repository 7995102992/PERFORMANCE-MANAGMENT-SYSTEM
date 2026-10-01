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
import { BandDialog } from "./BandDialog";
import {
  useBands,
  useCreateBand,
  useUpdateBand,
} from "@/hooks/queries/use-bands";
import { useAppSelector } from "@/store";
import type { Band } from "@/modules/org-setup/types/band";
import type { BandResponseDTO } from "@/api/org-setup/types";

// ─── Constants ────────────────────────────────────────────────────────────────

// const FREQUENCY_LABEL: Record<string, string> = {
//   monthly: 'Monthly',
//   annual: 'Annual',
//   hourly: 'Hourly',
// }

const STATUS_FILTER_OPTIONS = [
  { label: "All", value: "all" },
  { label: "Active", value: "active" },
  { label: "Inactive", value: "inactive" },
];

const ADD_ACTION_BUTTON_CLASS = "border-border text-foreground hover:bg-muted";

// ─── Component ────────────────────────────────────────────────────────────────

export function BandsPage() {
  const confirm = useConfirm();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingBand, setEditingBand] = useState<Band | null>(null);
  const [viewingBand, setViewingBand] = useState<Band | null>(null);

  // API data
  const savedOrg = useAppSelector((s) => s.organisation.savedOrganisation);
  const { data: bands = [], isLoading } = useBands(savedOrg?.id);
  const createBand = useCreateBand();
  const updateBand = useUpdateBand();

  // ── Filtering & pagination ────────────────────────────────────────────────

  const filtered = useMemo(() => {
    return bands.filter((b) => {
      const matchesSearch =
        !search ||
        b.name.toLowerCase().includes(search.toLowerCase()) ||
        (b.notes ?? "").toLowerCase().includes(search.toLowerCase());
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "active" && b.is_active) ||
        (statusFilter === "inactive" && !b.is_active);
      return matchesSearch && matchesStatus;
    });
  }, [bands, search, statusFilter]);

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
    setEditingBand(null);
    setDialogOpen(true);
  }

  function openEdit(band: BandResponseDTO) {
    setEditingBand({
      id: band.id,
      name: band.name,
      currency: band.currency ?? undefined,
      minAmount: band.minAmount ?? undefined,
      maxAmount: band.maxAmount ?? undefined,
      effectiveFrom: band.effectiveFrom ?? undefined,
      effectiveTo: band.effectiveTo ?? undefined,
      notes: band.notes ?? "",
      is_active: band.is_active,
    });
    setDialogOpen(true);
  }

  function handleSave(band: Band) {
    if (editingBand) {
      // Update
      confirm({
        title: "Update Band?",
        description: "Are you sure you want to update this band?",
        confirmText: "Update",
        onConfirm: async () => {
          await updateBand.mutateAsync({
            id: editingBand.id,
            payload: {
              name: band.name,
              // classLabel: band.classLabel,
              // frequency: band.frequency,
              currency: band.currency,
              minAmount: band.minAmount,
              maxAmount: band.maxAmount,
              effectiveFrom: band.effectiveFrom || null,
              effectiveTo: band.effectiveTo || null,
              notes: band.notes || null,
              is_active: band.is_active,
            },
          });
          setDialogOpen(false);
          setEditingBand(null);
        },
      });
    } else {
      // Create
      if (!savedOrg?.id) return;
      confirm({
        title: "Create Band?",
        description: "Are you sure you want to create this band?",
        confirmText: "Save",
        onConfirm: async () => {
          await createBand.mutateAsync({
            name: band.name,
            // classLabel: band.classLabel,
            // frequency: band.frequency,
            currency: band.currency ?? null,
            minAmount: band.minAmount ?? null,
            maxAmount: band.maxAmount ?? null,
            effectiveFrom: band.effectiveFrom || null,
            effectiveTo: band.effectiveTo || null,
            notes: band.notes || null,
            is_active: band.is_active,
          });
          setDialogOpen(false);
          setEditingBand(null);
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
          <h1 className="text-xl">Bands</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Define salary bands and compensation ranges.
          </p>
        </div>
        <Button variant="success" onClick={openAdd}>
          <Plus className="size-4" />
          Add Band
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-icon" />
          <Input
            placeholder="Search bands..."
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
              <TableHead className="w-[200px]">Band Name</TableHead>
              <TableHead>Salary Range</TableHead>
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
                  Loading bands...
                </TableCell>
              </TableRow>
            ) : paginated.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="h-24 text-center text-muted-foreground"
                >
                  No bands found.
                </TableCell>
              </TableRow>
            ) : (
              paginated.map((band) => (
                <TableRow
                  key={band.id}
                  className="cursor-pointer"
                  onClick={() => {
                    setViewingBand({
                      id: band.id,
                      name: band.name,
                      currency: band.currency ?? undefined,
                      minAmount: band.minAmount ?? undefined,
                      maxAmount: band.maxAmount ?? undefined,
                      effectiveFrom: band.effectiveFrom ?? undefined,
                      effectiveTo: band.effectiveTo ?? undefined,
                      notes: band.notes ?? "",
                      is_active: band.is_active,
                    });
                  }}
                >
                  <TableCell className="font-medium">{band.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {band.minAmount == null && band.maxAmount == null
                      ? "—"
                      : `${band.currency ? `${band.currency} ` : ""}${
                          band.minAmount != null
                            ? band.minAmount.toLocaleString()
                            : "—"
                        } - ${
                          band.maxAmount != null
                            ? band.maxAmount.toLocaleString()
                            : "—"
                        }`}
                  </TableCell>
                  <TableCell>
                    {band.is_active ? (
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
                          openEdit(band);
                        }}
                        title="Edit"
                      >
                        <Pencil className="size-4" />
                      </Button>
                      {/* <Button variant="ghost" size="icon" className="size-8 text-destructive hover:text-destructive" onClick={() => handleDelete(band)} title="Delete">
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
      <BandDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditingBand(null);
        }}
        editingBand={editingBand}
        onSave={handleSave}
      />

      {viewingBand && (
        <BandDialog
          open={!!viewingBand}
          onOpenChange={(open) => {
            if (!open) setViewingBand(null);
          }}
          editingBand={viewingBand}
          viewMode
          onEdit={() => {
            setEditingBand(viewingBand);
            setViewingBand(null);
            setDialogOpen(true);
          }}
        />
      )}
    </div>
  );
}
