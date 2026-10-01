import { useState } from "react";
import { formatDateIST, formatDateTimeIST } from "@/lib/format-ist";
import {
  Clock,
  CheckCircle2,
  Send,
  Loader2,
  Paperclip,
  Mail,
  CircleCheck,
  CircleX,
  Check,
  UserCheck,
  TrendingUp,
  X,
  AlertTriangle,
  User,
  AlertCircle,
} from "lucide-react";
import { EmptyState } from "@/components/shared/EmptyState";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  StatusCell,
  PriorityCell,
} from "@/pages/service-request/MyRequestList";
import {
  useGetRequestByIdQuery,
  useGetRequestCommentsQuery,
  useGetRequestNotesQuery,
  useAddCommentMutation,
  useAddNoteMutation,
  useFirstResponseMutation,
  useApproveRequestMutation,
  useRejectRequestMutation,
  useResolveRequestMutation,
  useCloseRequestMutation,
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

interface Props {
  id: string | null;
  onClose: () => void;
}

export const ApprovalAction = ({ id, onClose }: Props) => {
  const [activeTab, setActiveTab] = useState("comments");
  const [commentText, setCommentText] = useState("");
  const [noteText, setNoteText] = useState("");

  const [approveModalOpen, setApproveModalOpen] = useState(false);
  const [rejectModalOpen, setRejectModalOpen] = useState(false);
  const [approveComment, setApproveComment] = useState("");
  const [rejectReason, setRejectReason] = useState("");

  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [selectedExecutorId, setSelectedExecutorId] = useState("");
  const [assignNotes, setAssignNotes] = useState("");

  const [escalateDialogOpen, setEscalateDialogOpen] = useState(false);
  const [escalateToId, setEscalateToId] = useState("");
  const [escalateReason, setEscalateReason] = useState("");

  const [actionDialog, setActionDialog] = useState<{
    type: "resolve" | "close";
    open: boolean;
  } | null>(null);
  const [actionRemark, setActionRemark] = useState("");

  const {
    data: request,
    isLoading,
    isError,
  } = useGetRequestByIdQuery(id!, { skip: !id });

  const { data: commentsData } = useGetRequestCommentsQuery(id!, { skip: !id });
  const { data: notesData } = useGetRequestNotesQuery(id!, { skip: !id });
  const { data: eligibleExecutors = [] } = useGetEligibleExecutorsQuery(id!, {
    skip: !assignDialogOpen || !id,
  });
  const { data: escalationData } = useGetEligibleEscalationTargetsQuery(id!, {
    skip: !escalateDialogOpen || !id,
  });
  const escalationTargets = escalationData?.items ?? [];
  const noEscalationTargetReason = escalationData?.reason;

  const comments = commentsData?.items ?? [];
  const notes = notesData?.items ?? [];

  const [addComment, { isLoading: isAddingComment }] = useAddCommentMutation();
  const [addNote, { isLoading: isAddingNote }] = useAddNoteMutation();
  const [firstResponse, { isLoading: isFirstResponse }] =
    useFirstResponseMutation();
  const [approveRequest, { isLoading: isApproving }] =
    useApproveRequestMutation();
  const [rejectRequest, { isLoading: isRejecting }] =
    useRejectRequestMutation();
  const [resolveRequest, { isLoading: isResolving }] =
    useResolveRequestMutation();
  const [closeRequest, { isLoading: isClosing }] = useCloseRequestMutation();
  const [assignExecutor, { isLoading: isAssigning }] =
    useAssignExecutorMutation();
  const [selfAssign, { isLoading: isSelfAssigning }] = useSelfAssignMutation();
  const [reassignExecutor, { isLoading: isReassigning }] =
    useReassignExecutorMutation();
  const [escalateRequest, { isLoading: isEscalating }] =
    useEscalateRequestMutation();

  const handleAddComment = async () => {
    if (!commentText.trim()) return;
    try {
      await addComment({ id: id!, body: commentText.trim() }).unwrap();
      toast.success("Comment added");
      setCommentText("");
    } catch (err) {
      toast.error(err, "Failed to add comment");
    }
  };

  const handleAddNote = async () => {
    if (!noteText.trim()) return;
    try {
      await addNote({ id: id!, body: noteText.trim() }).unwrap();
      toast.success("Note added");
      setNoteText("");
    } catch (err) {
      toast.error(err, "Failed to add note");
    }
  };

  const handleFirstResponse = async () => {
    try {
      await firstResponse(id!).unwrap();
      toast.success("First response recorded");
    } catch (err) {
      toast.error(err, "Failed to record first response");
    }
  };

  const handleSelfAssign = async () => {
    try {
      await selfAssign(id!).unwrap();
      toast.success("Ticket self-assigned");
      onClose();
    } catch (err) {
      toast.error(err, "Failed to self-assign");
    }
  };

  const handleApprove = async () => {
    try {
      await approveRequest({
        id: id!,
        remarks: approveComment || undefined,
      }).unwrap();
      toast.success("Ticket approved");
      setApproveModalOpen(false);
      setApproveComment("");
      onClose();
    } catch (err) {
      toast.error(err, "Failed to approve ticket");
    }
  };

  const handleReject = async () => {
    try {
      await rejectRequest({ id: id!, reason: rejectReason }).unwrap();
      toast.success("Ticket rejected");
      setRejectModalOpen(false);
      setRejectReason("");
      onClose();
    } catch (err) {
      toast.error(err, "Failed to reject ticket");
    }
  };

  const handleResolveOrClose = async () => {
    const isResolve = actionDialog?.type === "resolve";
    try {
      if (isResolve) {
        await resolveRequest({
          id: id!,
          resolution_notes: actionRemark || "",
        }).unwrap();
        toast.success("Ticket resolved");
      } else {
        await closeRequest({ id: id!, closing_remarks: actionRemark }).unwrap();
        toast.success("Ticket closed");
      }
      setActionDialog(null);
      setActionRemark("");
      onClose();
    } catch (err) {
      toast.error(
        err,
        isResolve ? "Failed to resolve ticket" : "Failed to close ticket",
      );
    }
  };

  const isReassign = !!request?.capabilities.can_reassign_executor;

  const handleAssignExecutor = async () => {
    const mutation = isReassign ? reassignExecutor : assignExecutor;
    try {
      await mutation({
        id: id!,
        executor_user_id: selectedExecutorId,
        notes: assignNotes || "",
      }).unwrap();
      toast.success(isReassign ? "Executor reassigned" : "Executor assigned");
      setAssignDialogOpen(false);
      setSelectedExecutorId("");
      setAssignNotes("");
      onClose();
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
    try {
      await escalateRequest({
        id: id!,
        escalate_to_user_id: escalateToId,
        reason: escalateReason,
      }).unwrap();
      toast.success("Ticket escalated");
      setEscalateDialogOpen(false);
      setEscalateToId("");
      setEscalateReason("");
      onClose();
    } catch (err) {
      toast.error(err, "Failed to escalate ticket");
    }
  };

  const caps = request?.capabilities;
  // Same reason as RequestDetail: don't render a separator with nothing beside
  // it. Mirrors the buttons in the header row below.
  const hasHeaderActions = Boolean(
    caps &&
      (caps.can_first_response ||
        caps.can_approve ||
        caps.can_reject ||
        caps.can_assign_executor ||
        caps.can_reassign_executor ||
        caps.can_self_assign ||
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
          if (!open) onClose();
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
                  <SheetTitle className="text-base font-semibold leading-snug truncate">
                    {request.title}
                  </SheetTitle>
                  <SheetDescription asChild>
                    <div className="flex items-center gap-2.5 mt-1.5 flex-wrap">
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
                      onClick={handleFirstResponse}
                      disabled={isFirstResponse}
                    >
                      <Check />
                      {isFirstResponse ? "Marking..." : "First Response"}
                    </Button>
                  )}
                  {caps.can_approve && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-xs h-8"
                      onClick={() => setApproveModalOpen(true)}
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
                      onClick={() => setRejectModalOpen(true)}
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
                      <UserCheck className="size-3.5" />
                      {isReassign ? "Reassign" : "Assign Executor"}
                    </Button>
                  )}
                  {caps.can_self_assign && (
                    <Button
                      size="sm"
                      className="gap-1.5 text-xs h-8"
                      onClick={handleSelfAssign}
                      disabled={isSelfAssigning}
                    >
                      <UserCheck className="size-3.5" />
                      {isSelfAssigning ? "Assigning..." : "Self Assign"}
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
                      <Check />
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
                      <X className="size-3.5 text-muted-foreground" />
                      Close
                    </Button>
                  )}
                  {caps.can_escalate && (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-xs text-badge-pending-text hover:underline underline-offset-2"
                      onClick={() => setEscalateDialogOpen(true)}
                    >
                      <TrendingUp className="size-3 shrink-0" />
                      Escalate
                    </button>
                  )}
                </>
              )}
              {hasHeaderActions && (
                <div className="w-px h-5 bg-border mx-1 shrink-0" />
              )}
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0"
                onClick={onClose}
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

          {!isLoading && request && caps && (
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

                {/* Approval required banner */}
                {caps.can_approve && (
                  <div className="flex items-center justify-between rounded-xl border bg-card px-5 py-4">
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        This ticket requires your approval
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Review the details and use the action buttons above.
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5"
                        onClick={() => setApproveModalOpen(true)}
                      >
                        <CircleCheck className="size-4 text-success" />
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5"
                        onClick={() => setRejectModalOpen(true)}
                      >
                        <CircleX className="size-4 text-destructive" />
                        Reject
                      </Button>
                    </div>
                  </div>
                )}

                {/* Description */}
                <div className="rounded-xl border bg-card px-5 py-4">
                  <p className="text-sm font-semibold text-foreground mb-2">
                    Description
                  </p>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {request.description || "No description provided."}
                  </p>
                  {request.attachments.length > 0 && (
                    <div className="flex flex-wrap gap-3 mt-3 pt-3 border-t border-border">
                      {request.attachments.map((att) => (
                        <div
                          key={att.id}
                          className="flex items-center gap-1.5 text-sm text-primary"
                        >
                          <Paperclip className="size-3.5" />
                          <span>{att.filename}</span>
                          <span className="text-xs text-muted-foreground">
                            ({formatBytes(att.size_bytes)})
                          </span>
                        </div>
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
                        <p className="text-sm font-medium mt-0.5 capitalize flex items-center gap-1">
                          {request.sla.first_response_status === "met" ? (
                            <CheckCircle2 className="size-3.5 text-success shrink-0" />
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
                        <p className="text-sm font-medium mt-0.5 capitalize flex items-center gap-1">
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
                            Executor
                          </p>
                          <p className="text-sm font-semibold mt-0.5">
                            {request.assignment.executor_name}
                          </p>
                          {request.assignment.executor_role && (
                            <p className="text-xs text-muted-foreground">
                              {request.assignment.executor_role}
                            </p>
                          )}
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
                          <a
                            href={`mailto:${request.assignment.executor_contact}`}
                            className="text-sm text-primary hover:underline flex items-center gap-1"
                          >
                            <Mail className="size-3 shrink-0" />
                            {request.assignment.executor_contact}
                          </a>
                        )}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No executor assigned yet.
                      </p>
                    )}
                  </div>
                </div>

                {/* Approval Hierarchy */}
                {request.approvals.required && (
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
                    <div className="space-y-2">
                      {request.approvals.levels.map((lvl) => (
                        <div
                          key={lvl.level_index}
                          className="flex items-center justify-between rounded-xl border px-3 py-2.5"
                        >
                          <div className="flex items-center gap-2.5">
                            <User className="size-4 text-muted-foreground shrink-0" />
                            <div>
                              <p className="text-sm font-medium text-foreground">
                                {lvl.approver_name ??
                                  `Level ${lvl.level_index}`}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                Level {lvl.level_index}
                              </p>
                            </div>
                          </div>
                          <StatusCell status={lvl.status} />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Comments / Notes */}
                <div className="rounded-xl border bg-card px-5 py-4">
                  <Tabs value={activeTab} onValueChange={setActiveTab}>
                    <TabsList className="border-b border-border rounded-none bg-transparent p-0 h-auto gap-0 w-full justify-start">
                      <TabsTrigger
                        value="comments"
                        className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-2.5 text-sm"
                      >
                        Comments
                      </TabsTrigger>
                      <TabsTrigger
                        value="notes"
                        className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-2.5 text-sm"
                      >
                        Internal Notes
                      </TabsTrigger>
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
                      {caps.can_add_comment && (
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
                      {caps.can_add_internal_note && (
                        <div className="pt-2 space-y-2">
                          <Textarea
                            placeholder="Add an internal note..."
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
                            className={`absolute left-0 top-[3px] size-[7px] rounded-full ring-2 ring-background ${
                              isCompleted
                                ? "bg-success"
                                : isCurrent
                                  ? "bg-primary"
                                  : isRejected
                                    ? "bg-destructive"
                                    : "bg-border"
                            }`}
                          />
                          <p
                            className={`text-xs font-semibold ${isCompleted || isCurrent ? "text-foreground" : isRejected ? "text-destructive" : "text-muted-foreground"}`}
                          >
                            {step.stage
                              .replace(/_/g, " ")
                              .replace(/\b\w/g, (c) => c.toUpperCase())}
                          </p>
                          <p className="text-[11px] text-muted-foreground mt-0.5">
                            {step.at
                              ? formatDateTimeIST(step.at)
                              : isCompleted
                                ? "Done"
                                : isSkipped
                                  ? "Skipped"
                                  : isRejected
                                    ? "Rejected"
                                    : "Pending"}
                          </p>
                          {step.note && (
                            <p className="text-[11px] text-muted-foreground italic mt-0.5">
                              {step.note}
                            </p>
                          )}
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

      {/* Approve Modal */}
      <Dialog open={approveModalOpen} onOpenChange={setApproveModalOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Approve Ticket</DialogTitle>
            <DialogDescription>
              Add an optional comment for the requester or next approver.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Comment (Optional)</Label>
            <Textarea
              placeholder="Add any notes..."
              value={approveComment}
              onChange={(e) => setApproveComment(e.target.value)}
              className="resize-none min-h-[80px]"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setApproveModalOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="soft"
              disabled={isApproving}
              onClick={handleApprove}
            >
              <CircleCheck className="size-4" />
              {isApproving ? "Approving..." : "Approve"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject Modal */}
      <Dialog open={rejectModalOpen} onOpenChange={setRejectModalOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reject Ticket</DialogTitle>
            <DialogDescription>
              Rejecting will terminate the approval workflow. The requester will
              be notified.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>
              Rejection Reason <span className="text-destructive">*</span>
            </Label>
            <Textarea
              placeholder="Provide a reason for rejection..."
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              className="resize-none min-h-[80px]"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectModalOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="outline"
              className="text-destructive border-destructive hover:bg-destructive/10"
              disabled={!rejectReason.trim() || isRejecting}
              onClick={handleReject}
            >
              <CircleX className="size-4" />
              {isRejecting ? "Rejecting..." : "Reject"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Resolve / Close Modal */}
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
              <DialogTitle>
                {actionDialog.type === "resolve"
                  ? "Resolve Ticket"
                  : "Close Ticket"}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-2">
              <Label>
                {actionDialog.type === "resolve"
                  ? "Resolution Notes"
                  : "Closing Remarks"}
                {actionDialog.type === "close" && (
                  <span className="text-destructive"> *</span>
                )}
              </Label>
              <Textarea
                placeholder={
                  actionDialog.type === "resolve"
                    ? "Enter resolution notes..."
                    : "Enter closing remarks..."
                }
                value={actionRemark}
                onChange={(e) => setActionRemark(e.target.value)}
                className="resize-none min-h-[80px]"
              />
            </div>
            <DialogFooter>
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
                variant="soft"
                disabled={
                  isResolving ||
                  isClosing ||
                  (actionDialog.type === "close" && !actionRemark.trim())
                }
                onClick={handleResolveOrClose}
              >
                {isResolving || isClosing
                  ? "Processing..."
                  : actionDialog.type === "resolve"
                    ? "Resolve"
                    : "Close"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Assign Executor Modal */}
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
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {isReassign ? "Reassign Executor" : "Assign Executor"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>
                Executor <span className="text-destructive">*</span>
              </Label>
              <select
                value={selectedExecutorId}
                onChange={(e) => setSelectedExecutorId(e.target.value)}
                className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring h-9"
              >
                <option value="">Select Executor</option>
                {eligibleExecutors.map((ex) => (
                  <option key={ex.user_id} value={ex.user_id}>
                    {/* Flagged, not hidden — see `previously_escalated_by` in
                        srmApi.ts. */}
                    {ex.previously_escalated_by
                      ? `${ex.name ?? ex.user_id} — escalated this earlier`
                      : (ex.name ?? ex.user_id)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label>Assignment Notes</Label>
              <Textarea
                placeholder="Type your notes here"
                value={assignNotes}
                onChange={(e) => setAssignNotes(e.target.value)}
                className="resize-none min-h-[80px]"
              />
            </div>
          </div>
          <DialogFooter>
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
              disabled={!selectedExecutorId || isAssigning || isReassigning}
              onClick={handleAssignExecutor}
            >
              <UserCheck className="size-4" />
              {isAssigning || isReassigning
                ? "Assigning..."
                : isReassign
                  ? "Reassign"
                  : "Assign Executor"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Escalate Modal */}
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
            <DialogTitle>Escalate Ticket</DialogTitle>
            <DialogDescription>
              The escalation will transfer ownership to a higher authority for
              quicker resolution.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>
                Escalate To <span className="text-destructive">*</span>
              </Label>
              {escalationTargets.length === 0 ? (
                // Nobody eligible. Show the server's classified reason instead
                // of a dropdown whose only entry is "Select person".
                <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                  {noEscalationTargetReason
                    ? `This ticket cannot be escalated — ${noEscalationTargetReason}`
                    : "No escalation target available"}
                </div>
              ) : (
                <select
                  value={escalateToId}
                  onChange={(e) => setEscalateToId(e.target.value)}
                  className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring h-9"
                >
                  <option value="">Select person</option>
                  {escalationTargets.map((t) => {
                    const label = t.name ?? t.user_id;
                    return (
                      <option key={t.user_id} value={t.user_id}>
                        {t.email ? `${label} (${t.email})` : label}
                      </option>
                    );
                  })}
                </select>
              )}
            </div>
            <div className="space-y-2">
              <Label>
                Escalate Reason <span className="text-destructive">*</span>
              </Label>
              <Textarea
                placeholder="Provide a reason..."
                value={escalateReason}
                onChange={(e) => setEscalateReason(e.target.value)}
                className="resize-none min-h-[80px]"
              />
            </div>
            {escalateToId && (
              <div className="rounded-xl border bg-muted p-3 flex items-start gap-2">
                <AlertTriangle className="size-4 text-badge-pending-text shrink-0 mt-0.5" />
                <p className="text-sm text-muted-foreground">
                  Escalating will alert the selected person and potentially
                  bypass the SLA timers.
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
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
              disabled={!escalateToId || !escalateReason.trim() || isEscalating}
              onClick={handleEscalate}
            >
              <TrendingUp className="size-4" />
              {isEscalating ? "Escalating..." : "Escalate Ticket"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
