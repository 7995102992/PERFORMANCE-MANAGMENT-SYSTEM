import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  AlertCircle,
  ChevronDown,
  Loader2,
  Megaphone,
  MoreVertical,
  Paperclip,
  Pencil,
  Plus,
  Search,
  Trash2,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { TablePagination } from "@/components/shared/TablePagination";
import {
  useDeleteAnnouncementMutation,
  useGetAnnouncementsQuery,
  useUnpublishAnnouncementMutation,
} from "@/store/api/announcementsApi";
import type { Announcement } from "@/store/api/announcementsApi";
import {
  useGetBusinessUnitsQuery,
  useGetDepartmentsQuery,
} from "@/store/api/iamApi";
import { deptLabel } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { AnnouncementForm } from "./AnnouncementForm";

const STATUS_OPTIONS = [
  { label: "All Status", value: "all" },
  { label: "Published", value: "published" },
  { label: "Draft", value: "draft" },
] as const;

type StatusFilter = (typeof STATUS_OPTIONS)[number]["value"];

const formatDate = (value?: string | null) =>
  value
    ? new Date(value).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "—";

const AnnouncementList = () => {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [departmentFilter, setDepartmentFilter] = useState("all");
  const [businessUnitFilter, setBusinessUnitFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Announcement | null>(null);
  const [unpublishTarget, setUnpublishTarget] = useState<Announcement | null>(
    null,
  );

  const { data, isLoading, isError } = useGetAnnouncementsQuery({
    skip: (currentPage - 1) * pageSize,
    limit: pageSize,
    search: search || undefined,
    status: statusFilter === "all" ? undefined : statusFilter,
    department_id: departmentFilter === "all" ? undefined : departmentFilter,
    business_unit_id:
      businessUnitFilter === "all" ? undefined : businessUnitFilter,
  });

  const { data: departments = [] } = useGetDepartmentsQuery({ is_active: true });
  const { data: businessUnits = [] } = useGetBusinessUnitsQuery({
    is_active: true,
  });

  const announcements = data?.items ?? [];
  const total = data?.total ?? 0;

  const selectedDepartmentLabel =
    departmentFilter === "all"
      ? "All Departments"
      : (() => {
          const dept = departments.find((d) => d.id === departmentFilter);
          return dept ? deptLabel(dept) : "All Departments";
        })();
  const selectedBusinessUnitLabel =
    businessUnitFilter === "all"
      ? "All Business Units"
      : (businessUnits.find((bu) => bu.id === businessUnitFilter)
          ?.business_unit_name ?? "All Business Units");
  const selectedStatusLabel =
    STATUS_OPTIONS.find((s) => s.value === statusFilter)?.label ?? "All Status";

  const [deleteAnnouncement] = useDeleteAnnouncementMutation();
  const [unpublishAnnouncement] = useUnpublishAnnouncementMutation();

  const openCreate = () => {
    setEditId(null);
    setSheetOpen(true);
  };

  const openDetail = (id: string) =>
    navigate({
      to: "/announcements/$announcementId",
      params: { announcementId: id },
    });

  const openEdit = (id: string) => {
    setEditId(id);
    setSheetOpen(true);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteAnnouncement(deleteTarget.id).unwrap();
      toast.success("Announcement deleted");
    } catch (err) {
      toast.error(err, "Failed to delete announcement");
    } finally {
      setDeleteTarget(null);
    }
  };

  const handleUnpublish = async () => {
    if (!unpublishTarget) return;
    try {
      await unpublishAnnouncement(unpublishTarget.id).unwrap();
      toast.success("Announcement moved back to draft");
    } catch (err) {
      toast.error(err, "Failed to unpublish announcement");
    } finally {
      setUnpublishTarget(null);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const startIndex = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const endIndex = Math.min(safePage * pageSize, total);

  return (
    <div className="space-y-6">
      {/* Header card — `items-center` on the header row centres the CTA against
          the title block, matching the expense pages. */}
      <div className="rounded-xl border bg-card px-6 py-5 [&>div]:items-center">
        <PageHeader
          title="Announcements"
          subtitle="Publish company announcements to selected business units and departments"
          action={
            <Button className="gap-2" onClick={openCreate}>
              <Plus className="size-4" />
              New Announcement
            </Button>
          }
        />
      </div>

      <div className="rounded-xl border overflow-hidden bg-card">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
          <div className="relative flex-1 min-w-0 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search announcements..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setCurrentPage(1);
              }}
              className="pl-9"
            />
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="gap-2 text-muted-foreground font-normal h-9"
              >
                {selectedStatusLabel}
                <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {STATUS_OPTIONS.map((s) => (
                <DropdownMenuItem
                  key={s.value}
                  onClick={() => {
                    setStatusFilter(s.value);
                    setCurrentPage(1);
                  }}
                >
                  {s.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="gap-2 text-muted-foreground font-normal h-9 max-w-[220px] truncate"
              >
                <span className="truncate">{selectedBusinessUnitLabel}</span>
                <ChevronDown className="size-3.5 shrink-0" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="max-h-64 overflow-y-auto"
            >
              <DropdownMenuItem
                onClick={() => {
                  setBusinessUnitFilter("all");
                  setCurrentPage(1);
                }}
              >
                All Business Units
              </DropdownMenuItem>
              {businessUnits.map((bu) => (
                <DropdownMenuItem
                  key={bu.id}
                  onClick={() => {
                    setBusinessUnitFilter(bu.id);
                    setCurrentPage(1);
                  }}
                >
                  {bu.business_unit_name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="gap-2 text-muted-foreground font-normal h-9 max-w-[220px] truncate"
              >
                <span className="truncate">{selectedDepartmentLabel}</span>
                <ChevronDown className="size-3.5 shrink-0" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="max-h-64 overflow-y-auto"
            >
              <DropdownMenuItem
                onClick={() => {
                  setDepartmentFilter("all");
                  setCurrentPage(1);
                }}
              >
                All Departments
              </DropdownMenuItem>
              {departments.map((d) => (
                <DropdownMenuItem
                  key={d.id}
                  onClick={() => {
                    setDepartmentFilter(d.id);
                    setCurrentPage(1);
                  }}
                >
                  {deptLabel(d)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {isError && (
          <EmptyState
            variant="error"
            icon={AlertCircle}
            title="Failed to load announcements"
            description="Please try again."
          />
        )}

        {!isLoading && !isError && (
          <>
            <Table>
              <TableHeader>
                <TableRow className="bg-table-header hover:bg-table-header border-b border-table-border">
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    Title
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    Departments
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    Attachments
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    Status
                  </TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground uppercase tracking-wide h-10">
                    Posted Date
                  </TableHead>
                  {/* Actions column — the 3-dot menu needs no header label. */}
                  <TableHead className="h-10 w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {announcements.map((announcement) => {
                  const isPublished = announcement.status === "published";
                  const departmentNames = announcement.department_names ?? [];
                  const attachmentCount = announcement.attachments?.length ?? 0;
                  return (
                    <TableRow
                      key={announcement.id}
                      // Published announcements are immutable — they open the
                      // read-only detail page; only drafts open the editor.
                      className="cursor-pointer"
                      onClick={() =>
                        isPublished
                          ? openDetail(announcement.id)
                          : openEdit(announcement.id)
                      }
                    >
                      <TableCell className="text-sm text-foreground font-medium max-w-[280px] truncate">
                        {announcement.title}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-[240px]">
                        <span className="block truncate">
                          {departmentNames.length === 0
                            ? "Organisation-wide"
                            : departmentNames.join(", ")}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {attachmentCount === 0 ? (
                          "—"
                        ) : (
                          <span className="flex items-center gap-1.5">
                            <Paperclip className="size-3.5 shrink-0" />
                            <span className="tabular-nums">
                              {attachmentCount}
                            </span>
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <StatusBadge
                          status={isPublished ? "active" : "draft"}
                          activeLabel="Published"
                        />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDate(announcement.posted_date)}
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-8"
                                aria-label="Row actions"
                              >
                                <MoreVertical className="size-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() => openEdit(announcement.id)}
                              >
                                <Pencil className="size-4" />
                                Edit
                              </DropdownMenuItem>
                              {/* Unpublish is the way back to an editable
                                  draft — a published record is immutable
                                  server-side. */}
                              {isPublished && (
                                <DropdownMenuItem
                                  onClick={() => setUnpublishTarget(announcement)}
                                >
                                  <Undo2 className="size-4" />
                                  Unpublish
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={() => setDeleteTarget(announcement)}
                              >
                                <Trash2 className="size-4 text-destructive" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {announcements.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="p-0">
                      <EmptyState
                        icon={Megaphone}
                        title="No announcements found"
                        description="Create your first announcement to keep everyone in the loop."
                        action={
                          <Button onClick={openCreate}>
                            <Plus />
                            New Announcement
                          </Button>
                        }
                      />
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            <TablePagination
              currentPage={safePage}
              totalPages={totalPages}
              startIndex={startIndex}
              endIndex={endIndex}
              total={total}
              pageSize={pageSize}
              onPageChange={setCurrentPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setCurrentPage(1);
              }}
            />
          </>
        )}
      </div>

      <AnnouncementForm
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        editId={editId}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete announcement?"
        description={`This will permanently remove "${deleteTarget?.title ?? ""}" and its attachments. This action cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleDelete}
      />

      <ConfirmDialog
        open={unpublishTarget !== null}
        onOpenChange={(open) => !open && setUnpublishTarget(null)}
        title="Unpublish announcement?"
        description={`"${unpublishTarget?.title ?? ""}" will be moved back to draft and will no longer appear on employee dashboards.`}
        confirmLabel="Unpublish"
        onConfirm={handleUnpublish}
      />
    </div>
  );
};

export default AnnouncementList;
