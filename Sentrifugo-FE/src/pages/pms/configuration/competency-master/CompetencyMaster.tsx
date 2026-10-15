import { useEffect, useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, Search, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/shared/EmptyState";
import { PageHeader } from "@/components/shared/PageHeader";
import { useConfirm } from "@/providers/confirm-dialog-provider";
import { toast } from "@/lib/toast";
import {
  useCreatePmsCompetencyMutation,
  useDeletePmsCompetencyMutation,
  useGetPmsCompetenciesQuery,
  useUpdatePmsCompetencyMutation,
} from "@/store/api/pmsApi";
import type { PmsCompetency, PmsCompetencyUpsert } from "@/types/pms-config";
import { COMPETENCY_CATEGORY_LABEL } from "../config.constants";
import { RowActions } from "../../shared/RowActions";
import {
  PMS_HEADER_ROW,
  PmsTableCard,
  PmsTh,
  ShowingFooter,
  SkeletonRows,
} from "../../shared/PmsTableCard";

/** Form rules for the competency popup: name, category and type are required. */
const schema = z.object({
  name: z.string().trim().min(1, "Competency is required").max(120, "Keep it under 120 characters"),
  category: z.enum(["behavioural", "technical", "leadership", "functional"]),
  type: z.enum(["hr", "manager"]),
  is_active: z.boolean(),
});

/** Blank form for "Add Competency": behavioural, manager-rated, active. */
const EMPTY: PmsCompetencyUpsert = { name: "", category: "behavioural", type: "manager", is_active: true };

/** Add / edit popup (screen 2.9). `competency` set means edit, null means add. */
function CompetencyDialog({
  open,
  competency,
  onOpenChange,
}: {
  open: boolean;
  competency: PmsCompetency | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [create, { isLoading: creating }] = useCreatePmsCompetencyMutation();
  const [update, { isLoading: updating }] = useUpdatePmsCompetencyMutation();
  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<PmsCompetencyUpsert>({ resolver: zodResolver(schema), defaultValues: EMPTY });

  // Each time the popup opens, load the competency (edit) or the blank form (add).
  useEffect(() => {
    if (open) {
      reset(
        competency
          ? {
              name: competency.name,
              category: competency.category,
              type: competency.type,
              is_active: competency.is_active,
            }
          : EMPTY,
      );
    }
  }, [open, competency, reset]);

  /** Saves the competency (update when editing, create otherwise), then closes the popup. */
  const onSubmit = async (body: PmsCompetencyUpsert) => {
    try {
      if (competency) await update({ id: competency.id, body }).unwrap();
      else await create(body).unwrap();
      toast.success(competency ? "Competency updated" : "Competency added");
      onOpenChange(false);
    } catch (e) {
      toast.error(e, "Could not save the competency");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 p-0">
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <DialogHeader className="border-b px-5 py-4">
            <DialogTitle>{competency ? "Edit Competency" : "Add Competency"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 px-5 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="comp-name">
                Competency <span className="text-destructive">*</span>
              </Label>
              <Input id="comp-name" autoFocus aria-invalid={!!errors.name} {...register("name")} />
              {errors.name && (
                <p role="alert" className="text-xs text-destructive">
                  {errors.name.message}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>
                Category <span className="text-destructive">*</span>
              </Label>
              <Controller
                control={control}
                name="category"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(COMPETENCY_CATEGORY_LABEL).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <div className="space-y-1.5">
              <Label>
                Competency Type <span className="text-destructive">*</span>
              </Label>
              <Controller
                control={control}
                name="type"
                render={({ field }) => (
                  <RadioGroup className="flex gap-6" value={field.value} onValueChange={field.onChange}>
                    <Label className="flex cursor-pointer items-center gap-2 font-normal">
                      <RadioGroupItem value="manager" /> Manager
                    </Label>
                    <Label className="flex cursor-pointer items-center gap-2 font-normal">
                      <RadioGroupItem value="hr" /> HR
                    </Label>
                  </RadioGroup>
                )}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Controller
                control={control}
                name="is_active"
                render={({ field }) => (
                  <RadioGroup
                    className="flex gap-6"
                    value={field.value ? "active" : "inactive"}
                    onValueChange={(v) => field.onChange(v === "active")}
                  >
                    <Label className="flex cursor-pointer items-center gap-2 font-normal">
                      <RadioGroupItem value="active" /> Active
                    </Label>
                    <Label className="flex cursor-pointer items-center gap-2 font-normal">
                      <RadioGroupItem value="inactive" /> Inactive
                    </Label>
                  </RadioGroup>
                )}
              />
            </div>
          </div>
          <DialogFooter className="mx-0 mb-0 rounded-b-xl border-t bg-transparent px-5 py-3">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={creating || updating}>
              {competency ? "Save" : "Add Competency"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Screen 2.9 — Competency Master. */
const CompetencyMaster = () => {
  const confirm = useConfirm();
  const { data: competencies = [], isLoading } = useGetPmsCompetenciesQuery();
  const [deleteCompetency] = useDeletePmsCompetencyMutation();
  const [updateCompetency] = useUpdatePmsCompetencyMutation();
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState<{ open: boolean; competency: PmsCompetency | null }>({
    open: false,
    competency: null,
  });

  // Client-side search on the competency name.
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? competencies.filter((c) => c.name.toLowerCase().includes(q)) : competencies;
  }, [competencies, search]);

  /** Saves a new Competency Type straight from the row. */
  const changeType = async (c: PmsCompetency, type: PmsCompetency["type"]) => {
    if (type === c.type) return;
    try {
      await updateCompetency({
        id: c.id,
        body: { name: c.name, category: c.category, type, is_active: c.is_active },
      }).unwrap();
      toast.success(`${c.name} is now rated by ${type === "hr" ? "HR" : "the manager"}`);
    } catch (e) {
      toast.error(e, "Could not change the competency type");
    }
  };

  /** Confirms, then deletes the competency. The API refuses when a goal template uses it (409). */
  const handleDelete = (c: PmsCompetency) =>
    confirm({
      title: "Delete competency?",
      description: `"${c.name}" will be removed from the master. Competencies used in a goal template can't be deleted.`,
      confirmText: "Delete",
      variant: "destructive",
      onConfirm: async () => {
        try {
          await deleteCompetency(c.id).unwrap();
          toast.success("Competency deleted");
        } catch (e) {
          toast.error(e, "Could not delete the competency");
        }
      },
    });

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Competency Master"
        subtitle="Maintain competencies used in goal templates and appraisals"
        action={
          <Button onClick={() => setDialog({ open: true, competency: null })}>
            <Plus /> Add Competency
          </Button>
        }
      />

      <PmsTableCard>
        <div className="mb-4 space-y-1.5">
          <Label htmlFor="comp-search" className="text-sm font-medium text-foreground">
            Search
          </Label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="comp-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by competency"
              className="h-10 pl-9"
            />
          </div>
        </div>

        <Table>
          <TableHeader>
            <TableRow className={PMS_HEADER_ROW}>
              <PmsTh className="w-20">S.No</PmsTh>
              <PmsTh>Competency</PmsTh>
              <PmsTh>Category</PmsTh>
              <PmsTh>Competency Type</PmsTh>
              <PmsTh className="w-32">Actions</PmsTh>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <SkeletonRows cols={5} />
            ) : rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5}>
                  <EmptyState
                    icon={Star}
                    title={search ? "No competencies match your search" : "No competencies yet"}
                    description={search ? "Try a different keyword." : "Add the competencies assessed at year end."}
                  />
                </TableCell>
              </TableRow>
            ) : (
              rows.map((c, i) => (
                <TableRow key={c.id} className="hover:bg-muted/40">
                  <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                  <TableCell className="font-medium text-foreground">{c.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {COMPETENCY_CATEGORY_LABEL[c.category]}
                  </TableCell>
                  <TableCell>
                    {/* Competency Type decides who rates it, and can be changed here without opening the popup. */}
                    <Select value={c.type} onValueChange={(v) => changeType(c, v as PmsCompetency["type"])}>
                      <SelectTrigger className="w-36" aria-label={`Competency type of ${c.name}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="manager">Manager</SelectItem>
                        <SelectItem value="hr">HR</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <RowActions
                      subject={c.name}
                      onEdit={() => setDialog({ open: true, competency: c })}
                      onDelete={() => handleDelete(c)}
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        <ShowingFooter count={rows.length} noun="competencies" />
        <p className="px-1 pt-1 text-sm text-muted-foreground">
          Competency Type decides who rates it: Manager = L1 and L2, HR = Plant HR (Corporate Office: Corporate
          HR).
        </p>
      </PmsTableCard>

      <CompetencyDialog
        open={dialog.open}
        competency={dialog.competency}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
      />
    </div>
  );
};

export default CompetencyMaster;
