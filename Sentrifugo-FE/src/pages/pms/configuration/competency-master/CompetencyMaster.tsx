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
import { StatusBadge } from "@/components/shared/StatusBadge";
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

const schema = z.object({
  name: z.string().trim().min(1, "Competency is required").max(120, "Keep it under 120 characters"),
  category: z.enum(["behavioural", "technical", "leadership", "functional"]),
  is_active: z.boolean(),
});

const EMPTY: PmsCompetencyUpsert = { name: "", category: "behavioural", is_active: true };

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

  useEffect(() => {
    if (open) {
      reset(
        competency
          ? { name: competency.name, category: competency.category, is_active: competency.is_active }
          : EMPTY,
      );
    }
  }, [open, competency, reset]);

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
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState<{ open: boolean; competency: PmsCompetency | null }>({
    open: false,
    competency: null,
  });

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? competencies.filter((c) => c.name.toLowerCase().includes(q)) : competencies;
  }, [competencies, search]);

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
              <PmsTh>Status</PmsTh>
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
                    <StatusBadge status={c.is_active} />
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
