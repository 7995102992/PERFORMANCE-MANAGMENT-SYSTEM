import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  useCreatePmsKraMutation,
  useDeletePmsKraMutation,
  useGetPmsKrasQuery,
  useUpdatePmsKraMutation,
} from "@/store/api/pmsApi";
import type { PmsKra } from "@/types/pms-config";
import { RowActions } from "../../shared/RowActions";
import {
  PMS_HEADER_ROW,
  PmsTableCard,
  PmsTh,
  ShowingFooter,
  SkeletonRows,
} from "../../shared/PmsTableCard";

const schema = z.object({
  name: z.string().trim().min(1, "KRA is required").max(100, "Keep it under 100 characters"),
});
type FormValues = z.infer<typeof schema>;

/** Add / edit popup (screen 2.6). `kra` set → edit. */
function KraDialog({
  open,
  kra,
  existing,
  onOpenChange,
}: {
  open: boolean;
  kra: PmsKra | null;
  existing: PmsKra[];
  onOpenChange: (open: boolean) => void;
}) {
  const [create, { isLoading: creating }] = useCreatePmsKraMutation();
  const [update, { isLoading: updating }] = useUpdatePmsKraMutation();
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { name: "" } });

  useEffect(() => {
    if (open) reset({ name: kra?.name ?? "" });
  }, [open, kra, reset]);

  const onSubmit = async ({ name }: FormValues) => {
    // Cheap pre-check; the API's 409 stays the source of truth.
    if (existing.some((k) => k.id !== kra?.id && k.name.toLowerCase() === name.toLowerCase())) {
      setError("name", { message: "A KRA with this name already exists" });
      return;
    }
    try {
      if (kra) await update({ id: kra.id, body: { name } }).unwrap();
      else await create({ name }).unwrap();
      toast.success(kra ? "KRA updated" : "KRA added");
      onOpenChange(false);
    } catch (e) {
      toast.error(e, "Could not save the KRA");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 p-0">
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <DialogHeader className="border-b px-5 py-4">
            <DialogTitle>{kra ? "Edit KRA" : "Add KRA"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5 px-5 py-4">
            <Label htmlFor="kra-name">
              KRA <span className="text-destructive">*</span>
            </Label>
            <Input id="kra-name" autoFocus aria-invalid={!!errors.name} {...register("name")} />
            {errors.name && (
              <p role="alert" className="text-xs text-destructive">
                {errors.name.message}
              </p>
            )}
          </div>
          <DialogFooter className="mx-0 mb-0 rounded-b-xl border-t bg-transparent px-5 py-3">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={creating || updating}>
              {kra ? "Save" : "Add KRA"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Screen 2.5 — KRA Master. */
const KraMaster = () => {
  const confirm = useConfirm();
  const { data: kras = [], isLoading } = useGetPmsKrasQuery();
  const [deleteKra] = useDeletePmsKraMutation();
  const [dialog, setDialog] = useState<{ open: boolean; kra: PmsKra | null }>({
    open: false,
    kra: null,
  });

  const handleDelete = (kra: PmsKra) =>
    confirm({
      title: "Delete KRA?",
      description: `"${kra.name}" will be removed from the master. KRAs that still have KPIs mapped can't be deleted.`,
      confirmText: "Delete",
      variant: "destructive",
      onConfirm: async () => {
        try {
          await deleteKra(kra.id).unwrap();
          toast.success("KRA deleted");
        } catch (e) {
          toast.error(e, "Could not delete the KRA");
        }
      },
    });

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="KRA Master"
        subtitle="Maintain Key Result Areas"
        action={
          <Button onClick={() => setDialog({ open: true, kra: null })}>
            <Plus /> Add KRA
          </Button>
        }
      />

      <PmsTableCard>
        <Table>
          <TableHeader>
            <TableRow className={PMS_HEADER_ROW}>
              <PmsTh className="w-24">S.No</PmsTh>
              <PmsTh>KRA</PmsTh>
              <PmsTh className="w-40">Actions</PmsTh>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <SkeletonRows cols={3} />
            ) : kras.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={3}>
                  <EmptyState
                    icon={Target}
                    title="No KRAs yet"
                    description="Add the Key Result Areas your goal templates are built from."
                    action={
                      <Button onClick={() => setDialog({ open: true, kra: null })}>
                        <Plus /> Add KRA
                      </Button>
                    }
                  />
                </TableCell>
              </TableRow>
            ) : (
              kras.map((kra, i) => (
                <TableRow key={kra.id} className="hover:bg-muted/40">
                  <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                  <TableCell className="font-medium text-foreground">{kra.name}</TableCell>
                  <TableCell>
                    <RowActions
                      subject={kra.name}
                      onEdit={() => setDialog({ open: true, kra })}
                      onDelete={() => handleDelete(kra)}
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        <ShowingFooter count={kras.length} noun="KRAs" />
      </PmsTableCard>

      <KraDialog
        open={dialog.open}
        kra={dialog.kra}
        existing={kras}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
      />
    </div>
  );
};

export default KraMaster;
