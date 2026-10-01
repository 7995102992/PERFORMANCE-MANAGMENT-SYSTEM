import { useEffect, useState } from "react";
import { formatDateIST, formatDateTimeIST } from "@/lib/format-ist";
import {
  CheckCircle2,
  Paperclip,
  Clock,
  Loader2,
  Send,
  CircleCheck,
  CircleX,
  Wrench,
  UserPlus,
  TrendingUp,
  XCircle,
  X,
  Mail,
  AlertTriangle,
  User,
  Undo2,
  Copy,
  Check,
  AlertCircle,
} from "lucide-react";
import { EmptyState } from "@/components/shared/EmptyState";
import { store, useAppSelector } from "@/store";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  StatusCell,
  PriorityCell,
} from "@/pages/service-request/MyRequestList";
import {
  useGetRequestByIdQuery,
  useGetRequestActivityQuery,
  useGetRequestCommentsQuery,
  useGetRequestNotesQuery,
  useAddCommentMutation,
  useAddNoteMutation,
  useFirstResponseMutation,
  useSubmitForApprovalMutation,
  useTriggerL2ApprovalMutation,
  useGetEligibleL2ApproversQuery,
  useApproveRequestMutation,
  useRejectRequestMutation,
  useResolveRequestMutation,
  useCloseRequestMutation,
  useWithdrawRequestMutation,
  useGetAttachmentSignedUrlMutation,
  useGetEligibleExecutorsQuery,
  useAssignExecutorMutation,
  useSelfAssignMutation,
  useReassignExecutorMutation,
  useGetEligibleEscalationTargetsQuery,
  useEscalateRequestMutation,
} from "@/store/api/srmApi";
import { toast } from "@/lib/toast";

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
};

const actionConfig = {
  approve: {
    title: "Approve Ticket",
    description: "Are you sure you want to approve this ticket?",
    confirmLabel: "Approve",
    remarkLabel: "Remarks (optional)",
  },
  reject: {
    title: "Reject Ticket",
    description: "Are you sure you want to reject this ticket?",
    confirmLabel: "Reject",
    remarkLabel: "Reason for rejection",
  },
  resolve: {
    title: "Resolve Ticket",
    description: "Mark this ticket as resolved?",
    confirmLabel: "Resolve",
    remarkLabel: "Resolution notes *",
  },
  close: {
    title: "Close Ticket",
    description: "Are you sure you want to close this ticket?",
    confirmLabel: "Close",
    remarkLabel: "Closing remarks *",
  },
  withdraw: {
    title: "Withdraw Ticket",
    description:
      "Pull this ticket back. Once withdrawn, no further action is possible. You can raise a new ticket later if needed.",
    confirmLabel: "Withdraw",
    remarkLabel: "Reason (optional)",
  },
};

interface Props {
  id: string | null;
  onClose: () => void;
}

/** Format an ISO timestamp in IST, regardless of the viewer's own browser/OS
 *  timezone. formatDateTimeIST already handles the backend's naive-UTC (no tz
 *  suffix) timestamps defensively — see src/lib/format-ist.ts. */
const toLocalDateTime = (s?: string | null): string =>
  s ? formatDateTimeIST(s) : "";

/** Small inline button that copies `value` to the clipboard, with a brief
 *  check-mark confirmation. Used next to contact emails. */
const CopyButton = ({
  value,
  label = "Copy",
}: {
  value: string;
  label?: string;
}) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success("Email copied to clipboard");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy to clipboard");
    }
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      title={label}
      aria-label={label}
      className="text-muted-foreground hover:text-foreground transition-colors"
    >
      {copied ? <Check className="size-3.5 text-success" /> : <Copy />}
    </button>
  );
};

export const RequestDetail = ({ id, onClose }: Props) => {
  const [commentText, setCommentText] = useState("");
  const [noteText, setNoteText] = useState("");
  const [actionDialog, setActionDialog] = useState<{
    type: "approve" | "reject" | "resolve" | "close" | "withdraw";
    open: boolean;
  } | null>(null);
  const currentUserId = useAppSelector((s) => s.auth.user?.id ?? null);
  const [actionRemark, setActionRemark] = useState("");
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [selectedExecutorId, setSelectedExecutorId] = useState("");
  const [assignNotes, setAssignNotes] = useState("");
  const [escalateDialogOpen, setEscalateDialogOpen] = useState(false);
  const [escalateToId, setEscalateToId] = useState("");
  const [escalateReason, setEscalateReason] = useState("");
  // L2 trigger dialog — opened by a separate button after L1 has been approved.
  const [triggerL2Open, setTriggerL2Open] = useState(false);
  const [triggerL2UserId, setTriggerL2UserId] = useState<string>("");

  const {
    data: request,
    isLoading,
    isError,
  } = useGetRequestByIdQuery(id!, { skip: !id });
  const { data: commentsData } = useGetRequestCommentsQuery(id!, { skip: !id });
  // Skip the notes query for users who can't see them — avoids a silent 403
  // and keeps the network tab clean.
  const { data: notesData } = useGetRequestNotesQuery(id!, {
    skip: !id || !request?.capabilities?.can_see_internal_notes,
  });
  const { data: activityData } = useGetRequestActivityQuery(id!, { skip: !id });
  const activity = activityData?.items ?? [];
  const { data: eligibleExecutors = [] } = useGetEligibleExecutorsQuery(id!, {
    skip: !assignDialogOpen || !id,
  });
  const { data: escalationData } = useGetEligibleEscalationTargetsQuery(id!, {
    skip: !escalateDialogOpen || !id,
  });
  const escalationTargets = escalationData?.items ?? [];
  // Why the list is empty, when it is — classified server-side. Rendered in
  // place of the bare "No escalation target available", which named the symptom
  // and not the cause.
  const noEscalationTargetReason = escalationData?.reason;
  // Auto-select the first escalation target. It is no longer "always the dept
  // head" — the list is the category's primaries, and there may be several; the
  // dialog renders a read-only badge only when exactly one came back.
  useEffect(() => {
    if (escalateDialogOpen && escalationTargets.length > 0) {
      setEscalateToId(escalationTargets[0].user_id);
    }
  }, [escalateDialogOpen, escalationTargets]);

  const comments = commentsData?.items ?? [];
  const notes = notesData?.items ?? [];

  const [addComment, { isLoading: isAddingComment }] = useAddCommentMutation();
  const [addNote, { isLoading: isAddingNote }] = useAddNoteMutation();
  const [firstResponse, { isLoading: isFirstResponse }] =
    useFirstResponseMutation();
  const [submitForApproval, { isLoading: isSubmittingForApproval }] =
    useSubmitForApprovalMutation();
  const [triggerL2Approval, { isLoading: isTriggeringL2 }] =
    useTriggerL2ApprovalMutation();
  // L2 picker data — fetched only when the L2 trigger dialog opens.
  const { data: l2ApproverData, isLoading: isLoadingL2Approvers } =
    useGetEligibleL2ApproversQuery(id ?? "", {
      skip: !id || !triggerL2Open,
    });
  // Prefill with the requester's default L2 manager once we have it.
  useEffect(() => {
    if (!triggerL2Open) return;
    if (!l2ApproverData) return;
    setTriggerL2UserId((cur) => cur || l2ApproverData.default_l2_user_id || "");
  }, [triggerL2Open, l2ApproverData]);
  // Options for the L2 picker, hoisted out of the dialog so the empty case can
  // be detected before rendering the control. `candidates` is the leadership
  // pool; the requester's default L2 is prepended when it isn't already there.
  const l2Options = (l2ApproverData?.candidates ?? []).map((c) => ({
    label: c.email ? `${c.name} (${c.email})` : c.name,
    value: c.user_id,
  }));
  if (
    l2ApproverData?.default_l2_user_id &&
    !l2Options.some((o) => o.value === l2ApproverData.default_l2_user_id) &&
    l2ApproverData?.default_l2_name
  ) {
    l2Options.unshift({
      label: `${l2ApproverData.default_l2_name}${
        l2ApproverData.default_l2_email
          ? ` (${l2ApproverData.default_l2_email})`
          : ""
      } — Default L2 Manager`,
      value: l2ApproverData.default_l2_user_id,
    });
  }
  // Both sources empty means the requester has no L2 in their employee record
  // AND the leadership pool returned nobody. Without this the dialog rendered
  // an empty dropdown above a Send button that is disabled on `!triggerL2UserId`
  // — a dead control with no explanation, and the backend's NO_L2_MANAGER
  // message (which says exactly what to fix) could never be reached, because
  // the request it comes from can't be sent.
  const noL2Available = !!l2ApproverData && l2Options.length === 0;
  const [approveRequest, { isLoading: isApproving }] =
    useApproveRequestMutation();
  const [rejectRequest, { isLoading: isRejecting }] =
    useRejectRequestMutation();
  const [resolveRequest, { isLoading: isResolving }] =
    useResolveRequestMutation();
  const [closeRequest, { isLoading: isClosing }] = useCloseRequestMutation();
  const [withdrawRequest, { isLoading: isWithdrawing }] =
    useWithdrawRequestMutation();
  const [getAttachmentSignedUrl] = useGetAttachmentSignedUrlMutation();

  const handleDownloadAttachment = async (attachmentId: string) => {
    if (!id) return;
    try {
      const res = await getAttachmentSignedUrl({
        requestId: id,
        attachmentId,
      }).unwrap();

      // Two cases:
      //   - S3 presigned URL (absolute http(s)://) — auth is in the URL,
      //     open directly in a new tab.
      //   - Local-backend relative URL — needs the user's JWT in the
      //     Authorization header (browser tabs can't carry it), so fetch
      //     with auth and turn the bytes into a blob URL.
      const isAbsolute = /^https?:\/\//i.test(res.download_url);
      if (isAbsolute) {
        window.open(res.download_url, "_blank", "noopener,noreferrer");
        return;
      }

      const token = store.getState().auth.accessToken;
      const base = (import.meta.env.VITE_SRM_API_BASE_URL as string) || "";
      // Address the file through the SRM gateway base (VITE_SRM_API_BASE_URL,
      // e.g. http://host/api/request) + the relative attachment path — the same
      // way every other SRM call is routed. The backend's download_url carries
      // the SRM's INTERNAL prefix (/api/v1/service-requests), which the gateway
      // does NOT expose; resolving against it lands on the SPA host and
      // downloads index.html instead of the file.
      const fullUrl = `${base.replace(/\/+$/, "")}/requests/${id}/attachments/${attachmentId}/file`;
      const fetchRes = await fetch(fullUrl, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!fetchRes.ok) throw new Error(`Download failed (${fetchRes.status})`);
      const blob = await fetchRes.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = res.filename || "attachment";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objUrl);
    } catch (err) {
      toast.error(err, "Failed to download attachment");
    }
  };
  const [assignExecutor, { isLoading: isAssigning }] =
    useAssignExecutorMutation();
  const [selfAssign, { isLoading: isSelfAssigning }] = useSelfAssignMutation();
  const [reassignExecutor, { isLoading: isReassigning }] =
    useReassignExecutorMutation();
  const [escalateRequest, { isLoading: isEscalating }] =
    useEscalateRequestMutation();

  const isReassign = !!request?.capabilities.can_reassign_executor;
  const isActionPending =
    isApproving || isRejecting || isResolving || isClosing || isWithdrawing;

  // Requester-only Withdraw. The allowed statuses live in the backend state
  // machine (WITHDRAW_FROM) and now reach us as a capability — this used to
  // re-declare that set locally, which would drift silently the moment the BE
  // changed it. Withdraw is no longer the odd one out: every action on this
  // sheet is capability-gated.
  const canWithdraw = !!request?.capabilities.can_withdraw;

  const handleAddComment = async () => {
    if (!commentText.trim() || !id) return;
    try {
      await addComment({ id, body: commentText.trim() }).unwrap();
      toast.success("Comment added");
      setCommentText("");
    } catch (err) {
      toast.error(err, "Failed to add comment");
    }
  };

  const handleAddNote = async () => {
    if (!noteText.trim() || !id) return;
    try {
      await addNote({ id, body: noteText.trim() }).unwrap();
      toast.success("Note added");
      setNoteText("");
    } catch (err) {
      toast.error(err, "Failed to add note");
    }
  };

  const handleFirstResponse = async () => {
    if (!id) return;
    try {
      await firstResponse(id).unwrap();
      toast.success("First response recorded");
    } catch (err) {
      toast.error(err, "Failed to record first response");
    }
  };

  const handleSubmitForApproval = async () => {
    if (!id) return;
    try {
      await submitForApproval(id).unwrap();
      toast.success("Sent for L1 approval");
    } catch (err) {
      toast.error(err, "Failed to send for approval");
    }
  };

  const handleTriggerL2 = async () => {
    if (!id) return;
    // Send override only if the executor picked someone other than the default.
    const defaultL2 = l2ApproverData?.default_l2_user_id || "";
    const override =
      triggerL2UserId && triggerL2UserId !== defaultL2
        ? triggerL2UserId
        : undefined;
    try {
      await triggerL2Approval({
        id,
        level_2_approver_user_id: override,
      }).unwrap();
      toast.success("Sent for L2 approval");
      setTriggerL2Open(false);
      setTriggerL2UserId("");
    } catch (err) {
      toast.error(err, "Failed to send for L2 approval");
    }
  };

  const handleSelfAssign = async () => {
    if (!id) return;
    try {
      await selfAssign(id).unwrap();
      toast.success("Ticket self-assigned");
    } catch (err) {
      toast.error(err, "Failed to self-assign");
    }
  };

  const handleAction = async () => {
    if (!actionDialog || !id) return;
    const verbMap = {
      approve: {
        success: "Ticket approved",
        fail: "Failed to approve ticket",
      },
      reject: { success: "Ticket rejected", fail: "Failed to reject ticket" },
      resolve: {
        success: "Ticket resolved",
        fail: "Failed to resolve ticket",
      },
      close: { success: "Ticket closed", fail: "Failed to close ticket" },
      withdraw: {
        success: "Ticket withdrawn",
        fail: "Failed to withdraw ticket",
      },
    } as const;
    const labels = verbMap[actionDialog.type];
    try {
      switch (actionDialog.type) {
        case "approve":
          await approveRequest({ id, remarks: actionRemark || "" }).unwrap();
          break;
        case "reject":
          await rejectRequest({ id, reason: actionRemark }).unwrap();
          break;
        case "resolve":
          await resolveRequest({
            id,
            resolution_notes: actionRemark || "",
          }).unwrap();
          break;
        case "close":
          await closeRequest({ id, closing_remarks: actionRemark }).unwrap();
          break;
        case "withdraw":
          await withdrawRequest({
            id,
            reason: actionRemark.trim() || undefined,
          }).unwrap();
          break;
      }
      toast.success(labels.success);
      setActionDialog(null);
      setActionRemark("");
    } catch (err) {
      toast.error(err, labels.fail);
    }
  };

  const handleAssign = async () => {
    if (!id) return;
    const mutation = isReassign ? reassignExecutor : assignExecutor;
    try {
      await mutation({
        id,
        executor_user_id: selectedExecutorId,
        notes: assignNotes || "",
      }).unwrap();
      toast.success(isReassign ? "Executor reassigned" : "Executor assigned");
      setAssignDialogOpen(false);
      setSelectedExecutorId("");
      setAssignNotes("");
    } catch (err) {
      toast.error(
        err,
        isReassign
          ? "Failed to reassign executor"
          : "Failed to assign executor",
      );
    }
  };

  const handleEscalate = async () => {
    if (!id) return;
    try {
      await escalateRequest({
        id,
        escalate_to_user_id: escalateToId,
        reason: escalateReason,
      }).unwrap();
      toast.success("Ticket escalated");
      setEscalateDialogOpen(false);
      setEscalateToId("");
      setEscalateReason("");
    } catch (err) {
      toast.error(err, "Failed to escalate ticket");
    }
  };

  const handleClose = () => {
    setActionDialog(null);
    setActionRemark("");
    setAssignDialogOpen(false);
    setEscalateDialogOpen(false);
    onClose();
  };

  const caps = request?.capabilities;
  // The separator before the X button is only a separator if something sits on
  // the other side of it. A requester viewing their own resolved ticket now has
  // no actions at all, which left a stray vertical rule floating next to the
  // close icon. Keep this list in step with the buttons rendered below.
  const hasHeaderActions = Boolean(
    caps &&
      (caps.can_first_response ||
        caps.can_approve ||
        caps.can_reject ||
        caps.can_assign_executor ||
        caps.can_reassign_executor ||
        caps.can_self_assign ||
        caps.can_submit_for_approval ||
        caps.can_trigger_l2_approval ||
        caps.can_resolve ||
        caps.can_close ||
        caps.can_escalate),
  );
  const visibleTimeline =
    request?.timeline.filter((t) => t.status !== "hidden") ?? [];

  return (
    <>
      <Sheet
        open={!!id}
        onOpenChange={(open) => {
          if (!open) handleClose();
        }}
      >
        <SheetContent
          className="w-[80vw] max-w-[80vw] flex flex-col p-0 gap-0 overflow-x-hidden"
          showCloseButton={false}
        >
          {/* ── Header ── */}
          <div className="flex items-start justify-between gap-4 px-6 py-4 border-b shrink-0">
            <div className="min-w-0">
              {isLoading ? (
                <SheetTitle className="text-base">Loading...</SheetTitle>
              ) : isError || !request ? (
                <SheetTitle className="text-base text-destructive">
                  Failed to load ticket
                </SheetTitle>
              ) : (
                <>
                  <SheetTitle className="text-lg font-bold leading-tight text-foreground line-clamp-2">
                    {request.title}
                  </SheetTitle>
                  <SheetDescription asChild>
                    <div className="flex items-center gap-2.5 mt-2 flex-wrap">
                      <span className="text-xs text-muted-foreground font-mono">
                        {request.ticket_no}
                      </span>
                      <span className="text-muted-foreground/40 text-xs">
                        |
                      </span>
                      <StatusCell status={request.status} />
                      <span className="text-muted-foreground/40 text-xs">
                        |
                      </span>
                      <PriorityCell priority={request.priority} />
                    </div>
                  </SheetDescription>
                </>
              )}
            </div>

            {/* Action buttons + close */}
            <div className="flex items-center gap-1.5 flex-wrap min-w-0">
              {!isLoading && caps && (
                <>
                  {caps.can_first_response && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-xs h-8"
                      disabled={isFirstResponse}
                      onClick={handleFirstResponse}
                    >
                      <CircleCheck className="size-3.5" />
                      {isFirstResponse ? "Marking..." : "First Response"}
                    </Button>
                  )}
                  {caps.can_approve && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-xs h-8"
                      onClick={() =>
                        setActionDialog({ type: "approve", open: true })
                      }
                    >
                      <CircleCheck className="size-3.5 text-success" />
                      Approve
                    </Button>
                  )}
                  {caps.can_reject && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-xs h-8"
                      onClick={() =>
                        setActionDialog({ type: "reject", open: true })
                      }
                    >
                      <CircleX className="size-3.5 text-destructive" />
                      Reject
                    </Button>
                  )}
                  {(caps.can_assign_executor || caps.can_reassign_executor) && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-xs h-8"
                      onClick={() => setAssignDialogOpen(true)}
                    >
                      <UserPlus />
                      {isReassign ? "Reassign" : "Assign Executor"}
                    </Button>
                  )}
                  {caps.can_self_assign && (
                    <Button
                      size="sm"
                      className="gap-1.5 text-xs h-8"
                      disabled={isSelfAssigning}
                      onClick={handleSelfAssign}
                    >
                      <UserPlus />
                      {isSelfAssigning ? "Assigning..." : "Self Assign"}
                    </Button>
                  )}
                  {caps.can_submit_for_approval && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-xs h-8"
                      disabled={isSubmittingForApproval}
                      onClick={handleSubmitForApproval}
                    >
                      <AlertTriangle className="size-3.5" />
                      {isSubmittingForApproval
                        ? "Sending..."
                        : "Send for L1 Approval"}
                    </Button>
                  )}
                  {caps.can_trigger_l2_approval && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-xs h-8"
                      disabled={isTriggeringL2}
                      onClick={() => {
                        setTriggerL2UserId("");
                        setTriggerL2Open(true);
                      }}
                    >
                      <AlertTriangle className="size-3.5" />
                      Send for L2 Approval
                    </Button>
                  )}
                  {caps.can_resolve && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-xs h-8"
                      onClick={() =>
                        setActionDialog({ type: "resolve", open: true })
                      }
                    >
                      <Wrench className="size-3.5" />
                      Resolve
                    </Button>
                  )}
                  {caps.can_close && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-xs h-8"
                      onClick={() =>
                        setActionDialog({ type: "close", open: true })
                      }
                    >
                      <XCircle className="size-3.5 text-muted-foreground" />
                      Close
                    </Button>
                  )}
                  {canWithdraw && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-xs h-8"
                      onClick={() =>
                        setActionDialog({ type: "withdraw", open: true })
                      }
                    >
                      <Undo2 className="size-3.5 text-destructive" />
                      Withdraw
                    </Button>
                  )}
                  {caps.can_escalate && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-xs h-8"
                      onClick={() => setEscalateDialogOpen(true)}
                    >
                      <TrendingUp className="size-3.5" />
                      Escalate
                    </Button>
                  )}
                </>
              )}
              {!isLoading && hasHeaderActions && (
                <div className="w-px h-5 bg-border mx-1 shrink-0" />
              )}
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0"
                onClick={handleClose}
              >
                <X className="size-4 text-muted-foreground" />
              </Button>
            </div>
          </div>

          {/* ── Body ── */}
          {isLoading && (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {!isLoading && (isError || !request) && (
            <div className="flex-1 flex items-center justify-center">
              <EmptyState
                variant="error"
                icon={AlertCircle}
                title="Failed to load ticket details"
                description="Please try again."
              />
            </div>
          )}

          {!isLoading && request && (
            <div className="flex-1 flex overflow-hidden">
              {/* Left column — scrollable */}
              <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4 min-w-0">
                {/* Metadata grid */}
                <div className="rounded-xl border bg-card px-5 py-4">
                  <div className="grid grid-cols-3 gap-x-8 gap-y-4">
                    {[
                      {
                        label: "Requestor",
                        value:
                          request.requester_name ?? request.requester_user_id,
                      },
                      { label: "Ticket ID", value: request.ticket_no },
                      {
                        label: "Department",
                        value:
                          request.metadata.department_name ??
                          request.metadata.department_id ??
                          "—",
                      },
                      {
                        label: "Category",
                        value:
                          request.metadata.category_name ??
                          request.metadata.category_id,
                      },
                      {
                        label: "Ticket Type",
                        value:
                          request.metadata.request_type_name ??
                          request.metadata.request_type_id,
                      },
                      {
                        label: "Submitted",
                        value: formatDateIST(request.submitted_on),
                      },
                    ].map(({ label, value }) => (
                      <div key={label}>
                        <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                          {label}
                        </p>
                        <p className="text-sm font-medium text-foreground mt-1">
                          {value}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Description */}
                <div className="rounded-xl border bg-card px-5 py-4">
                  <p className="text-sm font-semibold text-foreground mb-2">
                    Description
                  </p>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {request.description || "No description provided."}
                  </p>
                  {request.attachments.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-border">
                      {request.attachments.map((att) => (
                        <button
                          key={att.id}
                          type="button"
                          onClick={() => handleDownloadAttachment(att.id)}
                          className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1.5 text-sm text-primary hover:bg-primary/5 hover:border-primary/30 transition-colors"
                          title={`Download ${att.filename}`}
                        >
                          <Paperclip className="size-3.5" />
                          <span className="font-medium">{att.filename}</span>
                          <span className="text-xs text-muted-foreground">
                            ({formatBytes(att.size_bytes)})
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* SLA + Assignment side by side. The SLA card is hidden
                    outright when the ticket's SLA is not in force (`enabled`
                    false): the backend raises no breach and sends no email for
                    those, so a "breached" badge here would describe an event
                    nobody was told about. Assignment then takes the full row. */}
                <div
                  className={`grid gap-4 ${
                    request.sla?.enabled === false
                      ? "grid-cols-1"
                      : "grid-cols-2"
                  }`}
                >
                  {/* SLA */}
                  {request.sla?.enabled !== false && (
                  <div className="rounded-xl border bg-card px-5 py-4">
                    <p className="text-sm font-semibold text-foreground mb-3">
                      Service Level Agreement
                    </p>
                    <div className="grid grid-cols-2 gap-3 mb-3">
                      <div>
                        <p className="text-xs text-muted-foreground">
                          First Response
                        </p>
                        <p
                          className={`text-sm font-medium mt-0.5 capitalize flex items-center gap-1 ${
                            request.sla.first_response_status === "met"
                              ? "text-info"
                              : ""
                          }`}
                        >
                          {request.sla.first_response_status === "met" ? (
                            <CheckCircle2 className="size-3.5 text-info shrink-0" />
                          ) : (
                            <Clock className="size-3.5 text-badge-pending-text shrink-0" />
                          )}
                          {request.sla.first_response_status?.replace(
                            /_/g,
                            " ",
                          ) ?? "—"}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">
                          Resolution
                        </p>
                        <p
                          className={`text-sm font-medium mt-0.5 capitalize flex items-center gap-1 ${
                            request.sla.resolution_status === "met"
                              ? "text-success"
                              : ""
                          }`}
                        >
                          {request.sla.resolution_status === "met" ? (
                            <CheckCircle2 className="size-3.5 text-success shrink-0" />
                          ) : (
                            <Clock className="size-3.5 text-badge-pending-text shrink-0" />
                          )}
                          {request.sla.resolution_status?.replace(/_/g, " ") ??
                            "—"}
                        </p>
                      </div>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-muted">
                      <div
                        className={`h-1.5 rounded-full ${request.sla.percent_used > 80 ? "bg-destructive" : request.sla.percent_used > 50 ? "bg-badge-pending-text" : "bg-success"}`}
                        style={{
                          width: `${Math.min(request.sla.percent_used, 100)}%`,
                        }}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {request.sla.percent_used}% of allocated time used
                    </p>
                  </div>
                  )}

                  {/* Assignment */}
                  <div className="rounded-xl border bg-card px-5 py-4">
                    <p className="text-sm font-semibold text-foreground mb-3">
                      Assignment Details
                    </p>
                    {request.assignment.executor_name ? (
                      <div className="space-y-2">
                        <div>
                          <p className="text-xs text-muted-foreground">
                            {request.assignment.executor_role ?? "Executor"}
                          </p>
                          <p className="text-sm font-semibold mt-0.5">
                            {request.assignment.executor_name}
                          </p>
                        </div>
                        {request.assignment.assigned_on && (
                          <div>
                            <p className="text-xs text-muted-foreground">
                              Assigned On
                            </p>
                            <p className="text-sm mt-0.5">
                              {formatDateIST(request.assignment.assigned_on)}
                            </p>
                          </div>
                        )}
                        {request.assignment.executor_contact && (
                          <div className="flex items-center gap-1.5">
                            <a
                              href={`mailto:${request.assignment.executor_contact}`}
                              className="text-sm text-primary hover:underline flex items-center gap-1"
                            >
                              <Mail />
                              {request.assignment.executor_contact}
                            </a>
                            <CopyButton
                              value={request.assignment.executor_contact}
                              label="Copy email address"
                            />
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        Executor not yet assigned
                      </p>
                    )}
                  </div>
                </div>

                {/* Approval Hierarchy — only after Send for Approval is triggered */}
                {request.approvals.required &&
                  request.approvals.triggered_at && (
                    <div className="rounded-xl border bg-card px-5 py-4">
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-sm font-semibold text-foreground">
                          Approval Hierarchy
                        </p>
                        <span className="text-xs text-muted-foreground">
                          {request.approvals.total_levels} level
                          {request.approvals.total_levels > 1 ? "s" : ""}
                        </span>
                      </div>
                      <div className="space-y-3">
                        {request.approvals.levels.map((lvl) => {
                          const isCurrent =
                            request.approvals.current_level_index ===
                              lvl.level_index &&
                            request.status?.toLowerCase() ===
                              "pending_approval";
                          const levelTitleCls =
                            lvl.status === "approved"
                              ? "text-success"
                              : lvl.status === "rejected"
                                ? "text-destructive"
                                : isCurrent
                                  ? "text-primary"
                                  : "text-muted-foreground";
                          const containerCls = isCurrent
                            ? "rounded-xl border-2 border-primary/40 bg-primary/5 px-3 py-2.5"
                            : "rounded-xl border border-border px-3 py-2.5";
                          const logicLabel =
                            lvl.approvers.length > 1
                              ? lvl.logic === "and"
                                ? " · ALL must approve"
                                : " · ANY can approve"
                              : "";
                          return (
                            <div key={lvl.level_index} className={containerCls}>
                              <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-2">
                                  {lvl.status === "approved" ? (
                                    <CheckCircle2 className="size-4 text-success shrink-0" />
                                  ) : lvl.status === "rejected" ? (
                                    <CircleX className="size-4 text-destructive shrink-0" />
                                  ) : isCurrent ? (
                                    <Clock className="size-4 text-primary shrink-0" />
                                  ) : (
                                    <User className="size-4 text-muted-foreground shrink-0" />
                                  )}
                                  <p
                                    className={`text-sm font-semibold ${levelTitleCls}`}
                                  >
                                    Level {lvl.level_index}
                                    <span className="text-xs font-normal text-muted-foreground">
                                      {logicLabel}
                                    </span>
                                  </p>
                                  {isCurrent && (
                                    <span className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-primary text-primary-foreground">
                                      Current
                                    </span>
                                  )}
                                </div>
                                <span
                                  className={`text-xs font-medium capitalize ${
                                    lvl.status === "approved"
                                      ? "text-success"
                                      : lvl.status === "rejected"
                                        ? "text-destructive"
                                        : "text-muted-foreground"
                                  }`}
                                >
                                  {lvl.status}
                                </span>
                              </div>
                              <div className="space-y-1.5">
                                {lvl.approvers.map((a) => {
                                  const isMe = a.user_id === currentUserId;
                                  return (
                                    <div
                                      key={a.user_id}
                                      className="flex items-start justify-between gap-3 text-sm"
                                    >
                                      <div className="flex items-start gap-2 min-w-0">
                                        {a.decision === "approved" ? (
                                          <CheckCircle2 className="size-3.5 text-success shrink-0 mt-0.5" />
                                        ) : a.decision === "rejected" ? (
                                          <CircleX className="size-3.5 text-destructive shrink-0 mt-0.5" />
                                        ) : (
                                          <Clock className="size-3.5 text-muted-foreground shrink-0 mt-0.5" />
                                        )}
                                        <div className="min-w-0">
                                          <p className="font-medium truncate">
                                            {a.name ?? a.user_id}
                                            {isMe && (
                                              <span className="ml-1.5 text-xs text-muted-foreground">
                                                (you)
                                              </span>
                                            )}
                                          </p>
                                          {a.remarks && (
                                            <p className="text-xs text-muted-foreground italic mt-0.5">
                                              "{a.remarks}"
                                            </p>
                                          )}
                                        </div>
                                      </div>
                                      <span className="text-xs text-muted-foreground shrink-0 whitespace-nowrap">
                                        {a.decided_at
                                          ? formatDateTimeIST(a.decided_at)
                                          : "Awaiting"}
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>
                              {isCurrent &&
                                lvl.approvers.some(
                                  (a) =>
                                    a.user_id === currentUserId &&
                                    a.decision !== null,
                                ) && (
                                  <p className="mt-2 pt-2 border-t border-primary/20 text-xs text-muted-foreground italic">
                                    You've already decided at this level.
                                  </p>
                                )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                {/* Resolution Notes — shown once the ticket has been resolved */}
                {request.resolution_notes && (
                  <div className="rounded-xl border bg-card px-5 py-4">
                    <p className="text-sm font-semibold text-foreground mb-2">
                      Resolution Notes
                    </p>
                    <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
                      {request.resolution_notes}
                    </p>
                  </div>
                )}

                {/* Closing Comments — shown once the ticket has been closed */}
                {request.closing_remarks && (
                  <div className="rounded-xl border bg-card px-5 py-4">
                    <p className="text-sm font-semibold text-foreground mb-2">
                      Closing Comments
                    </p>
                    <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
                      {request.closing_remarks}
                    </p>
                  </div>
                )}

                {/* Escalation — yellow/warning block with the escalation reason,
                    shown once the ticket has been escalated. */}
                {request.escalation_reason && (
                  <div className="rounded-xl border border-warning/30 bg-warning/10 px-5 py-4">
                    <div className="mb-2 flex items-center gap-2">
                      <AlertTriangle className="size-4 shrink-0 text-warning" />
                      <p className="text-sm font-semibold text-foreground">
                        Escalation
                      </p>
                    </div>
                    <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
                      {request.escalation_reason}
                    </p>
                  </div>
                )}

                {/* Comments / Notes — Internal Notes tab is hidden for
                    requesters / dept-colleagues (anyone without a note role). */}
                <div className="rounded-xl border bg-card px-5 py-4">
                  <Tabs defaultValue="comments">
                    <TabsList className="border-b border-border rounded-none bg-transparent p-0 h-auto gap-0 w-full justify-start">
                      {(caps?.can_see_internal_notes
                        ? ["comments", "notes"]
                        : ["comments"]
                      ).map((tab) => (
                        <TabsTrigger
                          key={tab}
                          value={tab}
                          className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-2.5 text-sm capitalize"
                        >
                          {tab === "notes"
                            ? "Internal Notes"
                            : tab.charAt(0).toUpperCase() + tab.slice(1)}
                        </TabsTrigger>
                      ))}
                    </TabsList>

                    <TabsContent value="comments" className="mt-4 space-y-4">
                      {comments.length === 0 && (
                        <p className="text-sm text-muted-foreground">
                          No comments yet.
                        </p>
                      )}
                      {comments.map((c, idx) => (
                        <div
                          key={c.id}
                          className={
                            idx < comments.length - 1
                              ? "border-b border-border pb-4"
                              : ""
                          }
                        >
                          <p className="text-sm font-semibold text-foreground">
                            {c.author_name ?? c.author_user_id}
                          </p>
                          <p className="text-xs text-muted-foreground mb-2">
                            {c.author_role ? `${c.author_role} · ` : ""}
                            {formatDateTimeIST(c.created_on)}
                          </p>
                          <p className="text-sm text-foreground/80 leading-relaxed">
                            {c.body}
                          </p>
                        </div>
                      ))}
                      {caps?.can_add_comment && (
                        <div className="pt-2 space-y-2">
                          <Textarea
                            placeholder="Type your comment here..."
                            value={commentText}
                            onChange={(e) => setCommentText(e.target.value)}
                            className="resize-none min-h-[80px]"
                          />
                          <div className="flex justify-end">
                            <Button
                              size="sm"
                              disabled={!commentText.trim() || isAddingComment}
                              onClick={handleAddComment}
                            >
                              <Send />
                              {isAddingComment ? "Sending..." : "Add Comment"}
                            </Button>
                          </div>
                        </div>
                      )}
                    </TabsContent>

                    {caps?.can_see_internal_notes && (
                      <TabsContent value="notes" className="mt-4 space-y-4">
                        {notes.length === 0 && (
                          <p className="text-sm text-muted-foreground">
                            No internal notes yet.
                          </p>
                        )}
                        {notes.map((n, idx) => (
                          <div
                            key={n.id}
                            className={
                              idx < notes.length - 1
                                ? "border-b border-border pb-4"
                                : ""
                            }
                          >
                            <p className="text-sm font-semibold text-foreground">
                              {n.author_name ?? n.author_user_id}
                            </p>
                            <p className="text-xs text-muted-foreground mb-2">
                              {n.author_role ? `${n.author_role} · ` : ""}
                              {formatDateTimeIST(n.created_on)}
                            </p>
                            <p className="text-sm text-foreground/80 leading-relaxed">
                              {n.body}
                            </p>
                          </div>
                        ))}
                        {caps?.can_add_internal_note && (
                          <div className="pt-2 space-y-2">
                            <Textarea
                              placeholder="Type your note here..."
                              value={noteText}
                              onChange={(e) => setNoteText(e.target.value)}
                              className="resize-none min-h-[80px]"
                            />
                            <div className="flex justify-end">
                              <Button
                                size="sm"
                                disabled={!noteText.trim() || isAddingNote}
                                onClick={handleAddNote}
                              >
                                <Send />
                                {isAddingNote ? "Sending..." : "Add Note"}
                              </Button>
                            </div>
                          </div>
                        )}
                      </TabsContent>
                    )}

                    <TabsContent value="activity" className="mt-4">
                      {activity.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          No activity yet.
                        </p>
                      ) : (
                        <ol className="relative space-y-3 border-l-2 border-border ml-2 pl-4">
                          {activity.map((e, idx) => (
                            <li key={`${e.event}-${idx}`} className="relative">
                              <span className="absolute -left-[1.4rem] top-1 size-2.5 rounded-full bg-primary border-2 border-card" />
                              <p className="text-sm font-medium text-foreground capitalize">
                                {e.event.replace(/_/g, " ")}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {e.actor_name ?? e.actor_user_id ?? "System"}
                                {" · "}
                                {formatDateTimeIST(e.created_on)}
                              </p>
                              {e.details &&
                                Object.keys(e.details).length > 0 && (
                                  <p className="text-xs text-muted-foreground italic mt-0.5">
                                    {Object.entries(e.details)
                                      .map(([k, v]) => `${k}: ${String(v)}`)
                                      .join(" · ")}
                                  </p>
                                )}
                            </li>
                          ))}
                        </ol>
                      )}
                    </TabsContent>
                  </Tabs>
                </div>
              </div>

              {/* Right column — timeline, scrolls independently */}
              <div className="w-72 shrink-0 border-l overflow-y-auto px-5 py-5">
                <p className="text-sm font-semibold text-foreground mb-5">
                  Ticket Timeline
                </p>
                {visibleTimeline.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No timeline events yet.
                  </p>
                ) : (
                  <div className="relative ml-2 space-y-5">
                    <div className="absolute left-[3px] top-2 bottom-2 w-px bg-border" />
                    {visibleTimeline.map((step, idx) => {
                      const isCompleted = step.status === "completed";
                      const isCurrent = step.status === "current";
                      const isSkipped = step.status === "skipped";
                      const isRejected = step.status === "rejected";
                      return (
                        <div key={idx} className="relative pl-5">
                          <div
                            className={`absolute left-0 top-[3px] size-[7px] rounded-full ring-2 ring-background ${isCompleted ? "bg-success" : isCurrent ? "bg-primary" : isRejected ? "bg-destructive" : "bg-border"}`}
                          />
                          <p
                            className={`text-xs font-semibold ${isCompleted || isCurrent ? "text-foreground" : isRejected ? "text-destructive" : "text-muted-foreground"}`}
                          >
                            {step.stage
                              .replace(/_/g, " ")
                              .replace(/\b\w/g, (c) => c.toUpperCase())}
                          </p>
                          {step.note && (
                            <p
                              className={`text-[11px] mt-0.5 ${isRejected ? "text-destructive" : "text-muted-foreground"}`}
                            >
                              {step.note}
                            </p>
                          )}
                          <p className="text-[11px] text-muted-foreground mt-0.5">
                            {step.at
                              ? toLocalDateTime(step.at)
                              : isCompleted
                                ? "Done"
                                : isSkipped
                                  ? "Skipped"
                                  : isRejected
                                    ? "Rejected"
                                    : "Pending"}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* Action Dialog */}
      {actionDialog && (
        <Dialog
          open={actionDialog.open}
          onOpenChange={(open) => {
            if (!open) {
              setActionDialog(null);
              setActionRemark("");
            }
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{actionConfig[actionDialog.type].title}</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              {actionConfig[actionDialog.type].description}
            </p>
            <div className="space-y-2 mt-2">
              <label className="text-sm font-medium">
                {actionConfig[actionDialog.type].remarkLabel}
              </label>
              <Textarea
                placeholder="Enter your remarks..."
                value={actionRemark}
                onChange={(e) => setActionRemark(e.target.value)}
                className="resize-none min-h-[80px]"
              />
            </div>
            <DialogFooter className="mt-4">
              <Button
                variant="outline"
                onClick={() => {
                  setActionDialog(null);
                  setActionRemark("");
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={handleAction}
                disabled={
                  isActionPending ||
                  ((actionDialog.type === "resolve" ||
                    actionDialog.type === "close") &&
                    !actionRemark.trim())
                }
                variant={
                  actionDialog.type === "reject" ? "destructive" : "soft"
                }
              >
                {isActionPending
                  ? "Processing..."
                  : actionConfig[actionDialog.type].confirmLabel}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Assign Executor Dialog */}
      <Dialog
        open={assignDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setAssignDialogOpen(false);
            setSelectedExecutorId("");
            setAssignNotes("");
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {isReassign ? "Reassign Executor" : "Assign Executor"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">
                Executor <span className="text-destructive">*</span>
              </label>
              <SearchableSelect
                options={eligibleExecutors.map((ex) => {
                  const label = ex.name ?? ex.user_id;
                  const withEmail = ex.email ? `${label} (${ex.email})` : label;
                  return {
                    value: ex.user_id,
                    // Flagged rather than hidden. This person escalated the
                    // ticket away; assigning it back to them is allowed and
                    // often right, but the primary should know it is what they
                    // are doing.
                    label: ex.previously_escalated_by
                      ? `${withEmail} — escalated this earlier`
                      : withEmail,
                  };
                })}
                value={selectedExecutorId}
                onChange={(val) => setSelectedExecutorId(val as string)}
                placeholder="Select Executor"
                emptyMessage="No eligible executors"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Assignment Notes</label>
              <Textarea
                placeholder="Type your notes here"
                value={assignNotes}
                onChange={(e) => setAssignNotes(e.target.value)}
                className="resize-none min-h-[80px]"
              />
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button
              variant="outline"
              onClick={() => {
                setAssignDialogOpen(false);
                setSelectedExecutorId("");
                setAssignNotes("");
              }}
            >
              Cancel
            </Button>
            <Button
              variant="soft"
              onClick={handleAssign}
              disabled={!selectedExecutorId || isAssigning || isReassigning}
            >
              {isAssigning || isReassigning
                ? "Assigning..."
                : isReassign
                  ? "Reassign Executor"
                  : "Assign Executor"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Escalate Dialog */}
      <Dialog
        open={escalateDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setEscalateDialogOpen(false);
            setEscalateToId("");
            setEscalateReason("");
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            {/* Was "Escalate to Department Head" — true only while the head was
                the sole target. Escalation goes to a primary executor on the
                ticket's category now, who may be neither the head nor in that
                department. */}
            <DialogTitle>Escalate Ticket</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This ticket will be handed to a primary executor on its category.
            Provide a reason for the escalation.
          </p>
          <div className="space-y-4 mt-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">
                Escalate To <span className="text-destructive">*</span>
              </label>
              {escalationTargets.length > 0 ? (
                <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
                  <span className="font-medium text-foreground">
                    {escalationTargets[0].name ?? escalationTargets[0].user_id}
                  </span>
                  {escalationTargets[0].email && (
                    <span className="text-muted-foreground">
                      ({escalationTargets[0].email})
                    </span>
                  )}
                </div>
              ) : (
                <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                  {noEscalationTargetReason
                    ? `This ticket cannot be escalated — ${noEscalationTargetReason}`
                    : "No escalation target available"}
                </div>
              )}
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">
                Escalate Reason <span className="text-destructive">*</span>
              </label>
              <Textarea
                placeholder="Provide a reason for escalation..."
                value={escalateReason}
                onChange={(e) => setEscalateReason(e.target.value)}
                className="resize-none min-h-[80px]"
              />
            </div>
            {escalateToId && (
              <div className="rounded-md border border-badge-pending-text/30 bg-badge-pending-bg p-3 flex items-start gap-2">
                <AlertTriangle className="size-4 text-badge-pending-text shrink-0 mt-0.5" />
                <p className="text-sm text-badge-pending-text">
                  Escalating will alert the selected person and potentially
                  bypass the SLA timers.
                </p>
              </div>
            )}
          </div>
          <DialogFooter className="mt-4">
            <Button
              variant="outline"
              onClick={() => {
                setEscalateDialogOpen(false);
                setEscalateToId("");
                setEscalateReason("");
              }}
            >
              Cancel
            </Button>
            <Button
              variant="soft"
              onClick={handleEscalate}
              disabled={!escalateToId || !escalateReason.trim() || isEscalating}
            >
              {isEscalating ? "Escalating..." : "Escalate Ticket"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Trigger L2 Approval Dialog */}
      <Dialog
        open={triggerL2Open}
        onOpenChange={(open) => {
          if (!open) {
            setTriggerL2Open(false);
            setTriggerL2UserId("");
          }
        }}
      >
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>Send for L2 Approval</DialogTitle>
            <p className="text-sm text-muted-foreground">
              L2 defaults to the requester&apos;s L2 manager. You can override
              with anyone from the leadership pool.
            </p>
          </DialogHeader>
          {isLoadingL2Approvers ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : noL2Available ? (
            <div className="flex gap-3 rounded-lg border border-warning/30 bg-warning/5 p-4">
              <AlertTriangle className="size-4 shrink-0 text-warning mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">
                  No L2 approver available for this ticket
                </p>
                <p className="text-sm text-muted-foreground">
                  The requester has no L2 manager set in their employee record,
                  so there is nobody to send this to. This is a gap in the
                  reporting hierarchy, not a problem with the ticket. Ask an
                  admin to set the L2 manager on the requester&apos;s employee
                  record, then reopen this dialog.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-2 py-4">
              <label className="text-sm font-medium">
                L2 Approver <span className="text-destructive">*</span>
              </label>
              <SearchableSelect
                options={l2Options}
                value={triggerL2UserId}
                onChange={(val) => setTriggerL2UserId(val as string)}
                placeholder="Select L2 approver..."
              />
              {l2ApproverData?.default_l2_user_id &&
                triggerL2UserId &&
                triggerL2UserId !== l2ApproverData.default_l2_user_id && (
                  <p className="text-xs text-muted-foreground">
                    Overriding default L2 manager.
                  </p>
                )}
              {!l2ApproverData?.default_l2_user_id && (
                <p className="text-xs text-muted-foreground">
                  Requester has no default L2 manager — pick one from
                  leadership.
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setTriggerL2Open(false);
                setTriggerL2UserId("");
              }}
            >
              {noL2Available ? "Close" : "Cancel"}
            </Button>
            {/* Hidden rather than disabled when there is no L2 to send to: a
                greyed-out button reads as "you lack permission" and invites
                retrying, when the fix is in the employee record. The panel
                above says what to do instead. */}
            {!noL2Available && (
              <Button
                variant="soft"
                onClick={handleTriggerL2}
                disabled={
                  isTriggeringL2 || isLoadingL2Approvers || !triggerL2UserId
                }
              >
                {isTriggeringL2 ? "Sending..." : "Send for L2 Approval"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
