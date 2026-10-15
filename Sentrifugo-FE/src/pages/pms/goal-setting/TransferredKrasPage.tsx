import { useMemo, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { AlertTriangle, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { toast } from "@/lib/toast";
import { fyToApi } from "@/store/api/pmsMappers";
import {
  useGetPmsTransferGoalSheetQuery,
  useSaveTransferGoalSheetMutation,
  useSendTransferGoalSheetMutation,
} from "@/store/api/pmsApi";
import type { PmsTransferGoalSheet, PmsTransferGoalSheetRequest } from "@/types/pms-manager";
import { formatDisplayDate } from "../shared/pms.utils";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../shared/PmsTableCard";
import { formatNumber, toFieldErrors, type FieldErrors } from "../shared/validation";
import { TRANSFER_REASONS, transferKraSchema, transferSchema, type TransferKraRow } from "./transfer.schema";

/** Label of the second period (after the transfer date). */
const P2_LABEL = "Period 2 · Oct 2026 – Mar 2027";
/** An empty KRA row for the Add KRA dialog. */
const blankKra = (): TransferKraRow => ({ id: "", kra_name: "", weight: "", target: "", unit: "" });

/** Screen 3.8 - Set Period 2 KRAs for an employee who transferred in mid-year. */
const TransferredKrasPage = () => {
  const { fy = "", employeeUserId = "" } = useParams({ strict: false }) as { fy?: string; employeeUserId?: string };
  const navigate = useNavigate();
  /** Back to My Team. */
  const back = () => navigate({ to: "/pms/team-goal-setting/$fy", params: { fy } });

  const financialYear = fyToApi(Number(fy));
  const { data, isLoading, isError } = useGetPmsTransferGoalSheetQuery({ employeeUserId, financialYear });

  if (isLoading) return <PageLoader message="Loading the goal sheet…" />;
  if (isError || !data) {
    return (
      <div className="space-y-6 p-6">
        <PageHeader title="Transferred Employee" subtitle="No transfer is recorded for this employee." />
        <Button variant="outline" onClick={back}>Back to My Team</Button>
      </div>
    );
  }

  return (
    <TransferForm
      key={employeeUserId}
      data={data}
      employeeUserId={employeeUserId}
      financialYear={financialYear}
      back={back}
    />
  );
};

/**
 * The editable form of screen 3.8: the earlier-period KRAs are frozen; the manager sets weights and
 * targets for the period 2 KRAs (template ones plus any added), a reason and remarks, then sends.
 */
const TransferForm = ({
  data,
  employeeUserId,
  financialYear,
  back,
}: {
  data: PmsTransferGoalSheet;
  employeeUserId: string;
  financialYear: string;
  back: () => void;
}) => {
  // Save-draft and send mutations for the transfer sheet.
  const [save, { isLoading: saving }] = useSaveTransferGoalSheetMutation();
  const [send, { isLoading: sending }] = useSendTransferGoalSheetMutation();

  // Period 2 KRA rows as typed.
  const [kras, setKras] = useState<TransferKraRow[]>(() =>
    data.kras
      .filter((k) => k.period === 2)
      .map((k) => ({
        id: k.id,
        kra_name: k.kra_name,
        weight: String(k.weight),
        target: k.target === null ? "" : String(k.target),
        unit: k.unit,
      })),
  );
  // Reason for the change and free-text remarks.
  const [reason, setReason] = useState(data.reason);
  const [remarks, setRemarks] = useState(data.remarks);
  // Validation messages keyed `kras.<index>.<field>` / `kras` / `reason` / `remarks`.
  const [errors, setErrors] = useState<FieldErrors>({});
  // Add / Edit KRA dialog: row being edited (index null = new) and its errors.
  const [dialog, setDialog] = useState<{ index: number | null; row: TransferKraRow } | null>(null);
  const [dialogErrors, setDialogErrors] = useState<FieldErrors>({});

  // Period 1 rows (locked) and where a period 2 row came from.
  const frozen = useMemo(() => data.kras.filter((k) => k.period === 1), [data]);
  const sourceOf = (id: string) => data.kras.find((k) => k.id === id)?.source_label ?? "Added by manager";
  // Weight totals of the two periods; period 2 must total 100.
  const p1Total = frozen.reduce((s, k) => s + k.weight, 0);
  const p2Total = kras.reduce((s, k) => s + (Number.isFinite(Number(k.weight)) ? Number(k.weight) : 0), 0);
  const totalOk = Math.abs(p2Total - 100) < 0.01;

  /** Removes one validation message. */
  const clearError = (key: string) =>
    setErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

  /** Updates the weight or target of one period 2 row. */
  const updateRow = (index: number, field: "weight" | "target", value: string) => {
    setKras((prev) => prev.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
    clearError(`kras.${index}.${field}`);
    clearError("kras");
  };

  /** Builds the API body: template rows keep their source; added rows are marked as added by the manager. */
  const payload = (): PmsTransferGoalSheetRequest => ({
    employee_user_id: employeeUserId,
    financial_year: financialYear,
    kras: kras.map((k) => {
      const existing = data.kras.find((d) => d.id === k.id);
      const fromTemplate = existing?.source === "template";
      return {
        kra_name: k.kra_name.trim(),
        weight: Number(k.weight) || 0,
        target: k.target.trim() === "" || !Number.isFinite(Number(k.target)) ? null : Number(k.target),
        unit: k.unit.trim(),
        source: fromTemplate ? "template" : "manager",
        source_label: existing?.source_label ?? "Added by manager",
      };
    }),
    reason,
    remarks,
  });

  /** Saves the sheet as a draft. */
  const onSaveDraft = async () => {
    try {
      await save(payload()).unwrap();
      toast.success("Draft saved");
    } catch (e) {
      toast.error(e, "Could not save the draft");
    }
  };

  /** Validates (weights total 100, reason, remarks of 10+ characters), then sends the sheet to the employee. */
  const onSend = async () => {
    const parsed = transferSchema.safeParse({ kras, reason, remarks });
    if (!parsed.success) {
      setErrors(toFieldErrors(parsed.error));
      toast.error("Fix the highlighted fields before sending");
      return;
    }
    try {
      await send(payload()).unwrap();
      toast.success("Goal sheet sent to the employee for acknowledgement");
      back();
    } catch (e) {
      toast.error(e, "Could not send the goal sheet");
    }
  };

  /** Opens the dialog with an empty KRA. */
  const openAdd = () => {
    setDialogErrors({});
    setDialog({ index: null, row: { ...blankKra(), id: `new-${Date.now()}` } });
  };

  /** Opens the dialog with an existing row. */
  const openEdit = (index: number) => {
    setDialogErrors({});
    setDialog({ index, row: { ...kras[index] } });
  };

  /** Validates the dialog row and adds it to the list (or replaces the edited one). */
  const commitDialog = () => {
    if (!dialog) return;
    const parsed = transferKraSchema.safeParse(dialog.row);
    if (!parsed.success) {
      setDialogErrors(toFieldErrors(parsed.error));
      return;
    }
    setKras((prev) =>
      dialog.index === null ? [...prev, dialog.row] : prev.map((r, i) => (i === dialog.index ? dialog.row : r)),
    );
    clearError("kras");
    setDialog(null);
  };

  /** Removes a period 2 row. */
  const removeRow = (index: number) => {
    setKras((prev) => prev.filter((_, i) => i !== index));
    clearError("kras");
  };

  /** Updates one field of the dialog row and clears its error. */
  const setDialogField = (field: keyof TransferKraRow, value: string) => {
    setDialog((d) => (d ? { ...d, row: { ...d.row, [field]: value } } : d));
    setDialogErrors((prev) => {
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title={`Goal Sheet – ${data.employee_name}`}
        subtitle="Add or modify KRAs when an employee changes department, role or manager"
        action={
          <span className="inline-flex items-center gap-1.5 text-sm text-blue-500">
            <RefreshCw className="h-4 w-4" /> Transferred
          </span>
        }
      />

      <PmsTableCard>
        <div className="grid gap-4 rounded-lg border p-3 text-sm sm:grid-cols-3">
          <div>
            <p className="text-xs text-muted-foreground">Employee</p>
            <p className="font-medium text-foreground">
              {data.employee_name} ({data.emp_code})
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Previous</p>
            <p className="font-medium text-foreground">
              {data.previous.department} · {data.previous.manager} · {data.previous.period_label}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Current</p>
            <p className="font-medium text-foreground">
              {data.current.department} · {data.current.manager} · {data.current.period_label}
            </p>
          </div>
          <div className="sm:col-span-3">
            <p className="text-xs text-muted-foreground">Transfer recorded by</p>
            <p className="font-medium text-foreground">
              {data.recorded_by} · {formatDisplayDate(data.recorded_on)}
            </p>
          </div>
        </div>

        <div className="mt-3 flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            <strong>Exception only.</strong> Add / Modify KRA is allowed when an employee changes department, role or
            manager during the year. Each period&apos;s KRAs add up to 100%; at year end the two periods are weighted by
            months. Every change is logged in the audit trail, and the goal sheet goes to the employee to acknowledge,
            back to you, then to the HOD for approval.
          </p>
        </div>

        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className={PMS_HEADER_ROW}>
              <PmsTh>KRA / KPI</PmsTh>
              <PmsTh>Source</PmsTh>
              <PmsTh>Period</PmsTh>
              <PmsTh>Weight %</PmsTh>
              <PmsTh>Target</PmsTh>
              <PmsTh>Unit</PmsTh>
              <PmsTh className="w-20" />
            </tr>
          </thead>
          <tbody>
            {frozen.map((k) => (
              <tr key={k.id} className="border-t">
                <td className="px-4 py-3 font-medium text-foreground">{k.kra_name}</td>
                <td className="px-4 py-3">
                  <span className="rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">{k.source_label}</span>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{k.period_label}</td>
                <td className="px-4 py-3 text-foreground">{k.weight}</td>
                <td className="px-4 py-3 text-foreground">{formatNumber(k.target)}</td>
                <td className="px-4 py-3 text-muted-foreground">{k.unit}</td>
                <td className="px-4 py-3 text-muted-foreground">—</td>
              </tr>
            ))}
            {kras.map((k, i) => {
              const manager = sourceOf(k.id) === "Added by manager" || k.id.startsWith("new-");
              const weightError = errors[`kras.${i}.weight`];
              const targetError = errors[`kras.${i}.target`];
              return (
                <tr key={k.id} className={`border-t align-top ${manager ? "bg-primary/5" : ""}`}>
                  <td className="px-4 py-3 font-medium text-foreground">{k.kra_name}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded px-2 py-0.5 text-xs ${
                        manager ? "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300" : "bg-primary/10 text-primary"
                      }`}
                    >
                      {manager ? "Added by manager" : sourceOf(k.id)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{P2_LABEL}</td>
                  <td className="px-4 py-3">
                    <Input
                      inputMode="decimal"
                      className={`w-20 ${weightError ? "border-destructive" : ""}`}
                      aria-label={`${k.kra_name} weight`}
                      aria-invalid={!!weightError}
                      value={k.weight}
                      onChange={(e) => updateRow(i, "weight", e.target.value)}
                    />
                    {weightError && <p className="mt-1 text-xs text-destructive">{weightError}</p>}
                  </td>
                  <td className="px-4 py-3">
                    <Input
                      inputMode="decimal"
                      className={`w-28 ${targetError ? "border-destructive" : ""}`}
                      aria-label={`${k.kra_name} target`}
                      aria-invalid={!!targetError}
                      value={k.target}
                      onChange={(e) => updateRow(i, "target", e.target.value)}
                    />
                    {targetError && <p className="mt-1 text-xs text-destructive">{targetError}</p>}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{k.unit}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="icon" aria-label={`Edit ${k.kra_name}`} onClick={() => openEdit(i)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive"
                        aria-label={`Remove ${k.kra_name}`}
                        onClick={() => removeRow(i)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <Button variant="outline" onClick={openAdd}>
            <Plus className="h-4 w-4" /> Add KRA
          </Button>
          <p className="text-sm text-muted-foreground">
            Period 1 weightage: <span className={p1Total === 100 ? "font-semibold text-emerald-600" : "font-semibold text-destructive"}>{p1Total}%</span>
            {" · "}Period 2 weightage:{" "}
            <span className={totalOk ? "font-semibold text-emerald-600" : "font-semibold text-destructive"}>
              {Math.round(p2Total * 100) / 100}%
            </span>
          </p>
        </div>
        {errors.kras && <p className="mt-2 text-sm text-destructive">{errors.kras}</p>}

        <div className="mt-4 grid gap-4 md:grid-cols-[16rem_1fr]">
          <div className="space-y-1.5">
            <Label>
              Reason for change <span className="text-destructive">*</span>
            </Label>
            <Select
              value={reason}
              onValueChange={(v) => {
                setReason(v);
                clearError("reason");
              }}
            >
              <SelectTrigger aria-invalid={!!errors.reason} className={errors.reason ? "border-destructive" : ""}>
                <SelectValue placeholder="Select a reason" />
              </SelectTrigger>
              <SelectContent>
                {TRANSFER_REASONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.reason && <p className="text-xs text-destructive">{errors.reason}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="transfer-remarks">
              Remarks <span className="text-destructive">*</span>
            </Label>
            <Input
              id="transfer-remarks"
              value={remarks}
              aria-invalid={!!errors.remarks}
              className={errors.remarks ? "border-destructive" : ""}
              onChange={(e) => {
                setRemarks(e.target.value);
                clearError("remarks");
              }}
            />
            {errors.remarks && <p className="text-xs text-destructive">{errors.remarks}</p>}
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between border-t pt-4">
          <Button variant="outline" onClick={back}>Back</Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onSaveDraft} disabled={saving || sending}>
              {saving ? "Saving…" : "Save Draft"}
            </Button>
            <Button onClick={onSend} disabled={saving || sending}>
              {sending ? "Sending…" : "Send to Employee"}
            </Button>
          </div>
        </div>
      </PmsTableCard>

      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialog?.index === null ? "Add KRA" : "Edit KRA"} · Period 2</DialogTitle>
          </DialogHeader>
          {dialog && (
            <div className="grid gap-3">
              {(
                [
                  ["kra_name", "KRA name", "text"],
                  ["weight", "Weight %", "decimal"],
                  ["target", "Target", "decimal"],
                  ["unit", "Unit", "text"],
                ] as const
              ).map(([field, label, mode]) => (
                <div key={field} className="space-y-1.5">
                  <Label htmlFor={`kra-${field}`}>{label}</Label>
                  <Input
                    id={`kra-${field}`}
                    inputMode={mode === "decimal" ? "decimal" : undefined}
                    value={dialog.row[field]}
                    aria-invalid={!!dialogErrors[field]}
                    className={dialogErrors[field] ? "border-destructive" : ""}
                    onChange={(e) => setDialogField(field, e.target.value)}
                  />
                  {dialogErrors[field] && <p className="text-xs text-destructive">{dialogErrors[field]}</p>}
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
            <Button onClick={commitDialog}>{dialog?.index === null ? "Add KRA" : "Save"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default TransferredKrasPage;
