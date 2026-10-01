import { useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ListChecks, Plus } from "lucide-react";
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
  useCreatePmsKpiMutation,
  useDeletePmsKpiMutation,
  useGetPmsKpisQuery,
  useGetPmsKpiUnitsQuery,
  useGetPmsKrasQuery,
  useUpdatePmsKpiMutation,
} from "@/store/api/pmsApi";
import type { PmsKpi, PmsKpiUpsert } from "@/types/pms-config";
import { TARGET_TYPE_LABEL } from "../config.constants";
import { RowActions } from "../../shared/RowActions";
import {
  PMS_HEADER_ROW,
  PmsTableCard,
  PmsTh,
  ShowingFooter,
  SkeletonRows,
} from "../../shared/PmsTableCard";

const schema = z.object({
  kra_id: z.string().min(1, "Select a KRA"),
  name: z.string().trim().min(1, "KPI is required").max(120, "Keep it under 120 characters"),
  unit: z.string().min(1, "Select a unit"),
  target_type: z.enum(["individual", "common"]),
  expected_outcome: z.string().trim().max(200, "Keep it under 200 characters"),
  evidence_required: z.string().trim().max(200, "Keep it under 200 characters"),
});

const EMPTY: PmsKpiUpsert = {
  kra_id: "",
  name: "",
  unit: "",
  target_type: "common",
  expected_outcome: "",
  evidence_required: "",
};

function FieldError({ message }: { message?: string }) {
  return message ? (
    <p role="alert" className="text-xs text-destructive">
      {message}
    </p>
  ) : null;
}

/** Add / edit popup (screen 2.8). `kpi` set → edit. */
function KpiDialog({
  open,
  kpi,
  onOpenChange,
}: {
  open: boolean;
  kpi: PmsKpi | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: kras = [] } = useGetPmsKrasQuery();
  const { data: units = [] } = useGetPmsKpiUnitsQuery();
  const [create, { isLoading: creating }] = useCreatePmsKpiMutation();
  const [update, { isLoading: updating }] = useUpdatePmsKpiMutation();
  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<PmsKpiUpsert>({ resolver: zodResolver(schema), defaultValues: EMPTY });

  useEffect(() => {
    if (open) reset(kpi ? { ...kpi } : EMPTY);
  }, [open, kpi, reset]);

  const onSubmit = async (body: PmsKpiUpsert) => {
    try {
      if (kpi) await update({ id: kpi.id, body }).unwrap();
      else await create(body).unwrap();
      toast.success(kpi ? "KPI updated" : "KPI added");
      onOpenChange(false);
    } catch (e) {
      toast.error(e, "Could not save the KPI");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-0 p-0">
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <DialogHeader className="border-b px-5 py-4">
            <DialogTitle>{kpi ? "Edit KPI" : "Add KPI"}</DialogTitle>
          </DialogHeader>

          <div className="max-h-[70vh] space-y-4 overflow-y-auto px-5 py-4">
            <div className="space-y-1.5">
              <Label>
                KRA <span className="text-destructive">*</span>
              </Label>
              <Controller
                control={control}
                name="kra_id"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="w-full" aria-invalid={!!errors.kra_id}>
                      <SelectValue placeholder="Select KRA" />
                    </SelectTrigger>
                    <SelectContent>
                      {kras.map((k) => (
                        <SelectItem key={k.id} value={k.id}>
                          {k.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <FieldError message={errors.kra_id?.message} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="kpi-name">
                KPI <span className="text-destructive">*</span>
              </Label>
              <Input id="kpi-name" aria-invalid={!!errors.name} {...register("name")} />
              <FieldError message={errors.name?.message} />
            </div>

            <div className="space-y-1.5">
              <Label>
                Unit <span className="text-destructive">*</span>
              </Label>
              <Controller
                control={control}
                name="unit"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="w-full" aria-invalid={!!errors.unit}>
                      <SelectValue placeholder="Select unit" />
                    </SelectTrigger>
                    <SelectContent>
                      {units.map((u) => (
                        <SelectItem key={u} value={u}>
                          {u}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <FieldError message={errors.unit?.message} />
            </div>

            <div className="space-y-1.5">
              <Label>
                Target Type <span className="text-destructive">*</span>
              </Label>
              <Controller
                control={control}
                name="target_type"
                render={({ field }) => (
                  <RadioGroup
                    className="flex gap-6"
                    value={field.value}
                    onValueChange={field.onChange}
                  >
                    <Label className="flex cursor-pointer items-center gap-2 font-normal">
                      <RadioGroupItem value="individual" /> Individual
                    </Label>
                    <Label className="flex cursor-pointer items-center gap-2 font-normal">
                      <RadioGroupItem value="common" /> Common
                    </Label>
                  </RadioGroup>
                )}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="kpi-outcome">Expected Outcome</Label>
              <Input
                id="kpi-outcome"
                aria-invalid={!!errors.expected_outcome}
                {...register("expected_outcome")}
              />
              <FieldError message={errors.expected_outcome?.message} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="kpi-evidence">Evidence Required</Label>
              <Input
                id="kpi-evidence"
                aria-invalid={!!errors.evidence_required}
                {...register("evidence_required")}
              />
              <FieldError message={errors.evidence_required?.message} />
            </div>
          </div>

          <DialogFooter className="mx-0 mb-0 rounded-b-xl border-t bg-transparent px-5 py-3">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={creating || updating}>
              {kpi ? "Save" : "Add KPI"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Screen 2.7 — KPI Master. */
const KpiMaster = () => {
  const confirm = useConfirm();
  const { data: kpis = [], isLoading } = useGetPmsKpisQuery();
  const [deleteKpi] = useDeletePmsKpiMutation();
  const [dialog, setDialog] = useState<{ open: boolean; kpi: PmsKpi | null }>({
    open: false,
    kpi: null,
  });

  const handleDelete = (kpi: PmsKpi) =>
    confirm({
      title: "Delete KPI?",
      description: `"${kpi.name}" will be removed from the master. KPIs used in a goal template can't be deleted.`,
      confirmText: "Delete",
      variant: "destructive",
      onConfirm: async () => {
        try {
          await deleteKpi(kpi.id).unwrap();
          toast.success("KPI deleted");
        } catch (e) {
          toast.error(e, "Could not delete the KPI");
        }
      },
    });

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="KPI Master"
        subtitle="Maintain KPIs and map them to KRAs"
        action={
          <Button onClick={() => setDialog({ open: true, kpi: null })}>
            <Plus /> Add KPI
          </Button>
        }
      />

      <PmsTableCard>
        <Table>
          <TableHeader>
            <TableRow className={PMS_HEADER_ROW}>
              <PmsTh className="w-20">S.No</PmsTh>
              <PmsTh>KRA</PmsTh>
              <PmsTh>KPI</PmsTh>
              <PmsTh>Unit</PmsTh>
              <PmsTh>Target Type</PmsTh>
              <PmsTh>Expected Outcome</PmsTh>
              <PmsTh>Evidence Required</PmsTh>
              <PmsTh className="w-28">Actions</PmsTh>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <SkeletonRows cols={8} />
            ) : kpis.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={8}>
                  <EmptyState
                    icon={ListChecks}
                    title="No KPIs yet"
                    description="Add KPIs and map them to a KRA."
                    action={
                      <Button onClick={() => setDialog({ open: true, kpi: null })}>
                        <Plus /> Add KPI
                      </Button>
                    }
                  />
                </TableCell>
              </TableRow>
            ) : (
              kpis.map((kpi, i) => (
                <TableRow key={kpi.id} className="hover:bg-muted/40">
                  <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                  <TableCell className="whitespace-normal text-muted-foreground">
                    {kpi.kra_name}
                  </TableCell>
                  <TableCell className="whitespace-normal font-semibold text-foreground">
                    {kpi.name}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{kpi.unit}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {TARGET_TYPE_LABEL[kpi.target_type]}
                  </TableCell>
                  <TableCell className="whitespace-normal text-muted-foreground">
                    {kpi.expected_outcome || "—"}
                  </TableCell>
                  <TableCell className="whitespace-normal text-muted-foreground">
                    {kpi.evidence_required || "—"}
                  </TableCell>
                  <TableCell>
                    <RowActions
                      subject={kpi.name}
                      onEdit={() => setDialog({ open: true, kpi })}
                      onDelete={() => handleDelete(kpi)}
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        <ShowingFooter count={kpis.length} noun="KPIs" />
      </PmsTableCard>

      <KpiDialog
        open={dialog.open}
        kpi={dialog.kpi}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
      />
    </div>
  );
};

export default KpiMaster;
