import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  CalendarDays,
  Copy,
  Eye,
  FileText,
  MoreVertical,
  Pencil,
  Plus,
  Power,
  PowerOff,
  Search,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import CopyTemplateDialog from "./CopyTemplateDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/shared/EmptyState";
import { PageHeader } from "@/components/shared/PageHeader";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useConfirm } from "@/providers/confirm-dialog-provider";
import { toast } from "@/lib/toast";
import {
  useDeletePmsTemplateMutation,
  useDuplicatePmsTemplateMutation,
  useGetPmsTemplatesQuery,
  useSetPmsTemplateStatusMutation,
} from "@/store/api/pmsApi";
import type { PmsGoalTemplateListItem } from "@/types/pms-config";
import { usePmsDepartments, usePmsPlants } from "../../shared/usePmsLookups";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh, SkeletonRows } from "../../shared/PmsTableCard";
import { financialYearLabel } from "../../shared/pms.utils";
import { currentFinancialYear, financialYearOptions } from "../config.constants";

/** Value of every "All ..." filter option. */
const ALL = "all";

/** Screen 2.1 — Goal Templates. */
const GoalTemplateList = () => {
  const navigate = useNavigate();
  const confirm = useConfirm();

  // Filters. The year is the financial year start; the others default to "all".
  const [year, setYear] = useState(currentFinancialYear());
  const [plant, setPlant] = useState(ALL);
  const [department, setDepartment] = useState(ALL);
  const [search, setSearch] = useState("");
  const [copyOpen, setCopyOpen] = useState(false);
  // Search waits 300 ms after the last keystroke before calling the API.
  const debouncedSearch = useDebouncedValue(search, 300);

  // Query parameters for the list call; "all" becomes undefined.
  const params = useMemo(
    () => ({
      financial_year: year,
      plant_id: plant === ALL ? undefined : plant,
      department_id: department === ALL ? undefined : department,
      search: debouncedSearch.trim() || undefined,
    }),
    [year, plant, department, debouncedSearch],
  );

  // Templates for the filters; plants and departments feed the filter dropdowns.
  const { data: templates = [], isLoading, isFetching } = useGetPmsTemplatesQuery(params);
  const { data: plants } = usePmsPlants();
  const { data: departments } = usePmsDepartments();
  // Row actions: activate / deactivate, duplicate and delete mutations.
  const [setStatus] = useSetPmsTemplateStatusMutation();
  const [duplicate] = useDuplicatePmsTemplateMutation();
  const [remove] = useDeletePmsTemplateMutation();

  // True when any filter is applied (controls the "Clear filters" button and the empty message).
  const hasFilters = plant !== ALL || department !== ALL || search !== "";
  /** Opens the wizard for a new template. */
  const create = () => navigate({ to: "/pms/configuration/goal-templates/new" });
  /** Opens a template: the edit wizard when `edit` is true, otherwise the read-only view. */
  const open = (t: PmsGoalTemplateListItem, edit = false) =>
    navigate({
      to: edit
        ? "/pms/configuration/goal-templates/$templateId/edit"
        : "/pms/configuration/goal-templates/$templateId",
      params: { templateId: t.id },
    });

  /** Activates or deactivates a template. The API refuses an incomplete template or a second active one for the same role (409). */
  const changeStatus = async (t: PmsGoalTemplateListItem, status: "active" | "inactive") => {
    try {
      await setStatus({ id: t.id, status }).unwrap();
      toast.success(status === "active" ? "Template activated" : "Template deactivated");
    } catch (e) {
      toast.error(e, "Could not change the template status");
    }
  };

  /** Creates a draft copy named "<name> (Copy)" with the same KRAs, KPIs and competencies. */
  const handleDuplicate = async (t: PmsGoalTemplateListItem) => {
    try {
      await duplicate(t.id).unwrap();
      toast.success("Template duplicated as a draft");
    } catch (e) {
      toast.error(e, "Could not duplicate the template");
    }
  };

  /** Confirms, then deletes the template (goals already set from it are not affected). */
  const handleDelete = (t: PmsGoalTemplateListItem) =>
    confirm({
      title: "Delete template?",
      description: `"${t.name}" will be permanently removed. Goals already set from it are not affected.`,
      confirmText: "Delete",
      variant: "destructive",
      onConfirm: async () => {
        try {
          await remove(t.id).unwrap();
          toast.success("Template deleted");
        } catch (e) {
          toast.error(e, "Could not delete the template");
        }
      },
    });

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Goal Templates"
        subtitle="Role-based goal templates used for goal setting"
        className="items-center"
        action={
          <div className="flex items-center gap-3">
            <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
              <SelectTrigger className="h-10 w-40 bg-card" aria-label="Financial year">
                <CalendarDays className="size-4 text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {financialYearOptions().map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {financialYearLabel(y)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="lg" variant="outline" onClick={() => setCopyOpen(true)}>
              Copy Template
            </Button>
            <Button size="lg" onClick={create}>
              <Plus /> Create Template
            </Button>
          </div>
        }
      />

      <CopyTemplateDialog open={copyOpen} onOpenChange={setCopyOpen} />

      <PmsTableCard>
        <div className="mb-5 flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label className="text-sm font-medium text-foreground">Plant</Label>
            <Select value={plant} onValueChange={setPlant}>
              <SelectTrigger className="h-10 w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All</SelectItem>
                {plants.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm font-medium text-foreground">Department</Label>
            <Select value={department} onValueChange={setDepartment}>
              <SelectTrigger className="h-10 w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All</SelectItem>
                {departments.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-search" className="text-sm font-medium text-foreground">
              Search
            </Label>
            <div className="relative w-64">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="tpl-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by template, role"
                className="h-10 pl-9"
              />
            </div>
          </div>
        </div>

        <Table>
          <TableHeader>
            <TableRow className={PMS_HEADER_ROW}>
              <PmsTh>Template Name</PmsTh>
              <PmsTh>Role / Designation</PmsTh>
              <PmsTh>Department</PmsTh>
              <PmsTh>Plant</PmsTh>
              <PmsTh>Status</PmsTh>
              <PmsTh className="w-36">Actions</PmsTh>
            </TableRow>
          </TableHeader>
          <TableBody className={isFetching && !isLoading ? "opacity-60 transition-opacity" : ""}>
            {isLoading ? (
              <SkeletonRows cols={6} />
            ) : templates.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6}>
                  <EmptyState
                    icon={FileText}
                    title={hasFilters ? "No templates match your filters" : `No templates for ${financialYearLabel(year)}`}
                    description={
                      hasFilters
                        ? "Try a different search or clear the filters."
                        : "Create a role-based template to use during goal setting."
                    }
                    action={
                      <Button onClick={create}>
                        <Plus /> Create Template
                      </Button>
                    }
                  />
                </TableCell>
              </TableRow>
            ) : (
              templates.map((t) => (
                <TableRow
                  key={t.id}
                  className="cursor-pointer hover:bg-muted/40"
                  onClick={() => open(t)}
                >
                  <TableCell className="font-medium text-foreground">{t.name}</TableCell>
                  <TableCell className="text-muted-foreground">{t.designation_name}</TableCell>
                  <TableCell className="text-muted-foreground">{t.department_name}</TableCell>
                  <TableCell className="text-muted-foreground">{t.plant}</TableCell>
                  <TableCell>
                    <StatusBadge status={t.status} />
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-0.5">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`View ${t.name}`} onClick={() => open(t)}>
                            <Eye />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>View</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Edit ${t.name}`} onClick={() => open(t, true)}>
                            <Pencil />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Edit</TooltipContent>
                      </Tooltip>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${t.name}`}>
                            <MoreVertical />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem onClick={() => handleDuplicate(t)}>
                            <Copy /> Duplicate
                          </DropdownMenuItem>
                          {t.status === "active" ? (
                            <DropdownMenuItem onClick={() => changeStatus(t, "inactive")}>
                              <PowerOff /> Deactivate
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem onClick={() => changeStatus(t, "active")}>
                              <Power /> Activate
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={() => handleDelete(t)}
                          >
                            <Trash2 /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </PmsTableCard>
    </div>
  );
};

export default GoalTemplateList;
