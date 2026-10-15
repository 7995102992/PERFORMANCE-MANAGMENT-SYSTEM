import { useState } from "react";
import { Plus, Trash2, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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
  useCreatePmsApprovalWorkflowMutation,
  useDeletePmsApprovalWorkflowMutation,
  useGetPmsApprovalWorkflowsQuery,
  useUpdatePmsApprovalWorkflowMutation,
} from "@/store/api/pmsApi";
import type { PmsApprovalWorkflow } from "@/types/pms";
import { RowActions } from "../../shared/RowActions";
import {
  PMS_HEADER_ROW,
  PmsTableCard,
  PmsTh,
  ShowingFooter,
  SkeletonRows,
} from "../../shared/PmsTableCard";

/** Longest name, step label and the most steps a workflow can have. */
const NAME_MAX = 200;
const STEP_MAX = 100;
const STEPS_MAX = 10;

/** The form inside the popup; it mounts each time the popup opens, so it starts from the workflow or blank. */
function WorkflowForm({
  workflow,
  onClose,
}: {
  workflow: PmsApprovalWorkflow | null;
  onClose: () => void;
}) {
  const [create, { isLoading: creating }] = useCreatePmsApprovalWorkflowMutation();
  const [update, { isLoading: updating }] = useUpdatePmsApprovalWorkflowMutation();
  const [name, setName] = useState(workflow?.name ?? "");
  const [description, setDescription] = useState(workflow?.description ?? "");
  const [steps, setSteps] = useState<string[]>(workflow?.steps ?? [""]);
  const [active, setActive] = useState((workflow?.status ?? "active") === "active");
  const [errors, setErrors] = useState<{ name?: string; steps?: string }>({});

  /** Checks the name and that every step is named, then creates or updates the workflow. */
  const submit = async () => {
    const trimmed = steps.map((s) => s.trim());
    const next: typeof errors = {};
    if (!name.trim()) next.name = "Workflow name is required";
    else if (name.trim().length > NAME_MAX) next.name = `Keep the name under ${NAME_MAX} characters`;
    if (trimmed.length === 0 || trimmed.some((s) => s === "")) next.steps = "Name every approver step";
    else if (new Set(trimmed.map((s) => s.toLowerCase())).size !== trimmed.length) {
      next.steps = "Each approver step must be different";
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const body = {
      name: name.trim(),
      description: description.trim(),
      steps: trimmed,
      status: active ? ("active" as const) : ("inactive" as const),
    };
    try {
      if (workflow) await update({ id: workflow.id, body }).unwrap();
      else await create(body).unwrap();
      toast.success(workflow ? "Workflow updated" : "Workflow added");
      onClose();
    } catch (e) {
      toast.error(e, "Could not save the workflow");
    }
  };

  return (
    <DialogContent className="max-w-xl">
      <DialogHeader>
        <DialogTitle>{workflow ? "Edit Approval Workflow" : "Add Approval Workflow"}</DialogTitle>
      </DialogHeader>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="wf-name">
            Workflow name <span className="text-destructive">*</span>
          </Label>
          <Input
            id="wf-name"
            value={name}
            maxLength={NAME_MAX}
            aria-invalid={!!errors.name}
            onChange={(e) => setName(e.target.value)}
          />
          {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="wf-description">Description</Label>
          <Input
            id="wf-description"
            value={description}
            maxLength={500}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label>
            Approvers, in order <span className="text-destructive">*</span>
          </Label>
          <div className="space-y-2">
            {steps.map((step, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-6 text-sm text-muted-foreground">{i + 1}</span>
                <Input
                  aria-label={`Approver ${i + 1}`}
                  value={step}
                  maxLength={STEP_MAX}
                  placeholder="e.g. Section Head"
                  onChange={(e) => setSteps((prev) => prev.map((s, idx) => (idx === i ? e.target.value : s)))}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove approver ${i + 1}`}
                  disabled={steps.length === 1}
                  onClick={() => setSteps((prev) => prev.filter((_, idx) => idx !== i))}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
          {errors.steps && <p className="text-xs text-destructive">{errors.steps}</p>}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={steps.length >= STEPS_MAX}
            onClick={() => setSteps((prev) => [...prev, ""])}
          >
            <Plus /> Add approver
          </Button>
        </div>

        <div className="space-y-1.5">
          <Label>Status</Label>
          <RadioGroup
            className="flex gap-6"
            value={active ? "active" : "inactive"}
            onValueChange={(v) => setActive(v === "active")}
          >
            <Label className="flex cursor-pointer items-center gap-2 font-normal">
              <RadioGroupItem value="active" /> Active
            </Label>
            <Label className="flex cursor-pointer items-center gap-2 font-normal">
              <RadioGroupItem value="inactive" /> Inactive
            </Label>
          </RadioGroup>
        </div>
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" onClick={submit} disabled={creating || updating}>
          {workflow ? "Save" : "Add Workflow"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** Configuration - Approval Workflow: the approver chains a cycle can pick on Rating Scale & Publish. */
const ApprovalWorkflow = () => {
  const confirm = useConfirm();
  const { data: workflows = [], isLoading } = useGetPmsApprovalWorkflowsQuery();
  const [remove] = useDeletePmsApprovalWorkflowMutation();
  const [dialog, setDialog] = useState<{ open: boolean; workflow: PmsApprovalWorkflow | null }>({
    open: false,
    workflow: null,
  });

  /** Confirms, then removes the workflow. The API refuses when a cycle uses it (409). */
  const handleDelete = (w: PmsApprovalWorkflow) =>
    confirm({
      title: "Delete approval workflow?",
      description: `"${w.name}" will be removed. A workflow used by a cycle can't be deleted.`,
      confirmText: "Delete",
      variant: "destructive",
      onConfirm: async () => {
        try {
          await remove(w.id).unwrap();
          toast.success("Workflow deleted");
        } catch (e) {
          toast.error(e, "Could not delete the workflow");
        }
      },
    });

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Approval Workflow"
        subtitle="Maintain the approver chains a cycle can use"
        action={
          <Button onClick={() => setDialog({ open: true, workflow: null })}>
            <Plus /> Add Workflow
          </Button>
        }
      />

      <PmsTableCard>
        <Table>
          <TableHeader>
            <TableRow className={PMS_HEADER_ROW}>
              <PmsTh className="w-20">S.No</PmsTh>
              <PmsTh>Workflow</PmsTh>
              <PmsTh>Approvers</PmsTh>
              <PmsTh>Status</PmsTh>
              <PmsTh className="w-32">Actions</PmsTh>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <SkeletonRows cols={5} />
            ) : workflows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5}>
                  <EmptyState
                    icon={Workflow}
                    title="No approval workflows yet"
                    description="Add the approver chains a cycle can use."
                  />
                </TableCell>
              </TableRow>
            ) : (
              workflows.map((w, i) => (
                <TableRow key={w.id} className="hover:bg-muted/40">
                  <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                  <TableCell className="font-medium text-foreground">{w.name}</TableCell>
                  <TableCell className="text-foreground">{w.steps.join(" → ")}</TableCell>
                  <TableCell className="text-foreground">
                    {w.status === "active" ? "Active" : "Inactive"}
                  </TableCell>
                  <TableCell>
                    <RowActions
                      subject={w.name}
                      onEdit={() => setDialog({ open: true, workflow: w })}
                      onDelete={() => handleDelete(w)}
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        <ShowingFooter count={workflows.length} noun="workflows" />
      </PmsTableCard>

      <Dialog open={dialog.open} onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}>
        {dialog.open && (
          <WorkflowForm
            workflow={dialog.workflow}
            onClose={() => setDialog((d) => ({ ...d, open: false }))}
          />
        )}
      </Dialog>
    </div>
  );
};

export default ApprovalWorkflow;
