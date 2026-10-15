import { useRef, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Lock, Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/shared/PageHeader";
import { PageLoader } from "@/components/shared/PageLoader";
import { toast } from "@/lib/toast";
import { fyToApi } from "@/store/api/pmsMappers";
import { useGetPmsRevisionRequestQuery, useSubmitPmsRevisionRequestMutation } from "@/store/api/pmsApi";
import type { PmsRevisionRequest } from "@/types/pms-manager";
import { PMS_HEADER_ROW, PmsTableCard, PmsTh } from "../shared/PmsTableCard";
import { formatNumber, toFieldErrors, type FieldErrors } from "../shared/validation";
import {
  ATTACHMENT_TYPES,
  MAX_ATTACHMENT_BYTES,
  revisionSchema,
  type RevisionFormRow,
} from "./midYear.schema";

/** Screen 3.12 - Raise Target Revision Request: at mid-year only target values change; KRAs and weightage are locked. */
const TargetRevisionRequestPage = () => {
  const { fy = "", employeeUserId = "" } = useParams({ strict: false }) as { fy?: string; employeeUserId?: string };
  const navigate = useNavigate();

  const { data, isLoading, isError } = useGetPmsRevisionRequestQuery({
    employeeUserId,
    financialYear: fyToApi(Number(fy)),
  });

  if (isLoading) return <PageLoader message="Loading the revision request…" />;
  if (isError || !data) {
    return (
      <div className="space-y-6 p-6">
        <PageHeader title="Target Revision Request" subtitle="Could not load this employee's goals." />
        <Button variant="outline" onClick={() => navigate({ to: "/pms/mid-year-review/$fy", params: { fy } })}>
          Back to My Team
        </Button>
      </div>
    );
  }

  return <RevisionForm key={employeeUserId} data={data} fy={fy} employeeUserId={employeeUserId} />;
};

/**
 * The editable part of screen 3.12: revise target values (weights are locked), give a reason for each
 * change, optionally attach a file, and send the request to the HOD.
 */
const RevisionForm = ({
  data,
  fy,
  employeeUserId,
}: {
  data: PmsRevisionRequest;
  fy: string;
  employeeUserId: string;
}) => {
  const navigate = useNavigate();
  // Hidden file input behind the "Attach file" button.
  const fileInput = useRef<HTMLInputElement>(null);
  // Submit mutation for the revision request.
  const [submit, { isLoading: sending }] = useSubmitPmsRevisionRequestMutation();

  // One row per KRA: current target, revised target (text) and the reason.
  const [rows, setRows] = useState<RevisionFormRow[]>(() =>
    data.kras.map((k) => ({
      kpi_id: k.kpi_id,
      current: k.current_target,
      revised: String(k.revised_target ?? k.current_target),
      reason: k.reason,
    })),
  );
  // Attached file name and its error; only the name is kept (file storage is not connected).
  const [attachment, setAttachment] = useState<string | null>(data.attachment_name);
  const [attachmentError, setAttachmentError] = useState("");
  // Validation messages keyed `rows.<index>.<field>`.
  const [errors, setErrors] = useState<FieldErrors>({});

  /** Back to the mid-year review page of this employee. */
  const toReview = () =>
    navigate({ to: "/pms/mid-year-review/$fy/employee/$employeeUserId", params: { fy, employeeUserId } });

  /** Updates the revised target or reason of one row and clears that error. */
  const update = (index: number, field: "revised" | "reason", value: string) => {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[`rows.${index}.${field}`];
      delete next.rows;
      return next;
    });
  };

  /** Accepts a PDF, Excel or image file of at most 5 MB; otherwise shows an error. */
  const onPickFile = (file: File | undefined) => {
    setAttachmentError("");
    if (!file) return;
    if (!ATTACHMENT_TYPES.includes(file.type)) {
      setAttachmentError("Attach a PDF, Excel or image file");
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setAttachmentError("The file must be 5 MB or smaller");
      return;
    }
    setAttachment(file.name);
  };

  /** Validates (at least one changed target, each with a reason), then sends only the changed rows to the HOD. */
  const onSend = async () => {
    const parsed = revisionSchema.safeParse({ rows });
    if (!parsed.success) {
      setErrors(toFieldErrors(parsed.error));
      toast.error("Fix the highlighted fields before sending");
      return;
    }
    try {
      await submit({
        employee_user_id: employeeUserId,
        financial_year: fyToApi(Number(fy)),
        rows: data.kras.flatMap((k, i) => {
          const revised = Number(rows[i].revised);
          return revised === k.current_target
            ? []
            : [{ kpi_id: k.kpi_id, revised_target: revised, reason: rows[i].reason.trim() }];
        }),
        attachment_name: attachment,
      }).unwrap();
      toast.success("Target revision sent to the HOD for approval");
      navigate({ to: "/pms/mid-year-review/$fy", params: { fy } });
    } catch (e) {
      toast.error(e, "Could not send the revision request");
    }
  };

  return (
    <div className="space-y-6 p-6">
      <PageHeader title="Target Revision Request" subtitle="Only target values can be revised at mid-year" />

      <PmsTableCard>
        <div className="grid gap-4 rounded-lg border p-3 text-sm sm:grid-cols-4">
          <div>
            <p className="text-xs text-muted-foreground">Employee</p>
            <p className="font-medium text-foreground">
              {data.employee_name} ({data.emp_code})
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Role</p>
            <p className="font-medium text-foreground">{data.role}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Manager</p>
            <p className="font-medium text-foreground">{data.manager}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Template</p>
            <p className="font-medium text-foreground">{data.template}</p>
          </div>
        </div>

        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className={PMS_HEADER_ROW}>
              <PmsTh>KRA</PmsTh>
              <PmsTh>Weight %</PmsTh>
              <PmsTh>Current target</PmsTh>
              <PmsTh>Revised target</PmsTh>
              <PmsTh>Units</PmsTh>
              <PmsTh>Reason</PmsTh>
            </tr>
          </thead>
          <tbody>
            {data.kras.map((k, i) => {
              const row = rows[i];
              if (!row) return null;
              const targetError = errors[`rows.${i}.revised`];
              const reasonError = errors[`rows.${i}.reason`];
              return (
                <tr key={k.kpi_id} className="border-t align-top">
                  <td className="px-4 py-3 font-medium text-foreground">{k.kra_name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{k.weight} (locked)</td>
                  <td className="px-4 py-3 text-foreground">{formatNumber(k.current_target)}</td>
                  <td className="px-4 py-3">
                    <Input
                      inputMode="decimal"
                      className={`w-28 ${targetError ? "border-destructive" : ""}`}
                      aria-label={`${k.kra_name} revised target`}
                      aria-invalid={!!targetError}
                      value={row.revised}
                      onChange={(e) => update(i, "revised", e.target.value)}
                    />
                    {targetError && <p className="mt-1 text-xs text-destructive">{targetError}</p>}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{k.unit}</td>
                  <td className="px-4 py-3">
                    <Input
                      className={reasonError ? "border-destructive" : ""}
                      aria-label={`${k.kra_name} reason`}
                      aria-invalid={!!reasonError}
                      value={row.reason}
                      onChange={(e) => update(i, "reason", e.target.value)}
                    />
                    {reasonError && <p className="mt-1 text-xs text-destructive">{reasonError}</p>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {errors.rows && <p className="mt-2 text-sm text-destructive">{errors.rows}</p>}

        <div className="mt-3 flex items-center gap-2 rounded-md bg-primary/10 px-3 py-2.5 text-sm text-primary">
          <Lock className="h-4 w-4 shrink-0" />
          Mid-year: only target values can be revised. KRAs and weightage are locked.
        </div>

        <div className="mt-4 space-y-1.5">
          <p className="text-sm font-medium text-foreground">Attachment</p>
          <input
            ref={fileInput}
            type="file"
            className="hidden"
            accept=".pdf,.xls,.xlsx,.png,.jpg,.jpeg"
            onChange={(e) => {
              onPickFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          {attachment ? (
            <span className="inline-flex items-center gap-2 text-sm text-primary">
              <Paperclip className="h-4 w-4" /> {attachment}
              <button type="button" aria-label="Remove attachment" onClick={() => setAttachment(null)}>
                <X className="h-4 w-4 text-muted-foreground" />
              </button>
            </span>
          ) : (
            <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
              <Paperclip className="h-4 w-4" /> Attach file
            </Button>
          )}
          {attachmentError && <p className="text-xs text-destructive">{attachmentError}</p>}
        </div>

        <div className="mt-4 flex items-center justify-between border-t pt-4">
          <Button variant="outline" onClick={toReview}>Back</Button>
          <Button onClick={onSend} disabled={sending}>
            {sending ? "Sending…" : "Send to HOD for Approval"}
          </Button>
        </div>
      </PmsTableCard>
    </div>
  );
};

export default TargetRevisionRequestPage;
