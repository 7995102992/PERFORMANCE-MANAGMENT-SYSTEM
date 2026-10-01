import { useEffect, useState } from "react";
import { formatDateTimeIST } from "@/lib/format-ist";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  Clock,
  User,
  Send,
  AlertTriangle,
  MessageSquare,
  StickyNote,
  Activity as ActivityIcon,
  Loader2,
  CircleCheck,
  AlertCircle,
} from "lucide-react";
import { EmptyState } from "@/components/shared/EmptyState";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { PageHeader } from "@/components/shared/PageHeader";
import { StatusCell } from "../MyRequestList";
import { toast } from "@/lib/toast";
import {
  useGetRequestByIdQuery,
  useGetRequestCommentsQuery,
  useGetRequestNotesQuery,
  useAddCommentMutation,
  useAddNoteMutation,
  useFirstResponseMutation,
  useSubmitForApprovalMutation,
  useResolveRequestMutation,
  useCloseRequestMutation,
  useAssignExecutorMutation,
  useSelfAssignMutation,
  useReassignExecutorMutation,
  useEscalateRequestMutation,
  useGetEligibleExecutorsQuery,
  useGetEligibleEscalationTargetsQuery,
} from "@/store/api/srmApi";

const priorityVariant: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  urgent: "destructive",
  high: "destructive",
  medium: "default",
  low: "secondary",
};

const formatDateTime = (s?: string | null) => (s ? formatDateTimeIST(s) : "—");

export const RequestExecute = () => {
  const navigate = useNavigate();
  const { id } = useParams({ from: "/service-request/queue/$id" });

  const { data: request, isLoading, isError } = useGetRequestByIdQuery(id);
  const { data: commentsData } = useGetRequestCommentsQuery(id, { skip: !id });
  const { data: notesData } = useGetRequestNotesQuery(id, { skip: !id });
  const comments = commentsData?.items ?? [];
  const notes = notesData?.items ?? [];

  const [activeTab, setActiveTab] = useState("comments");
  const [newComment, setNewComment] = useState("");
  const [newNote, setNewNote] = useState("");

  const [assignModalOpen, setAssignModalOpen] = useState(false);
  const [escalateModalOpen, setEscalateModalOpen] = useState(false);
  const [resolveModalOpen, setResolveModalOpen] = useState(false);
  const [closeModalOpen, setCloseModalOpen] = useState(false);

  const [selectedExecutor, setSelectedExecutor] = useState("");
  const [assignmentNotes, setAssignmentNotes] = useState("");
  const [escalateTo, setEscalateTo] = useState("");
  const [escalateReason, setEscalateReason] = useState("");
  const [resolutionNotes, setResolutionNotes] = useState("");
  const [closingRemarks, setClosingRemarks] = useState("");

  const { data: eligibleExecutors = [] } = useGetEligibleExecutorsQuery(id, {
    skip: !assignModalOpen,
  });
  const { data: escalationData } = useGetEligibleEscalationTargetsQuery(id, {
    skip: !escalateModalOpen,
  });
  const escalationTargets = escalationData?.items ?? [];
  const noEscalationTargetReason = escalationData?.reason;
  // When exactly one target comes back, auto-select it so the submit button
  // enables without a picker step. That used to mean "the dept head"; it now
  // means the category has exactly one eligible primary.
  useEffect(() => {
    if (escalateModalOpen && escalationTargets.length === 1) {
      setEscalateTo(escalationTargets[0].user_id);
    }
  }, [escalateModalOpen, escalationTargets]);

  const [addComment, { isLoading: isAddingComment }] = useAddCommentMutation();
  const [addNote, { isLoading: isAddingNote }] = useAddNoteMutation();
  const [firstResponse, { isLoading: isFirstResponse }] =
    useFirstResponseMutation();
  const [submitForApproval, { isLoading: isSubmittingForApproval }] =
    useSubmitForApprovalMutation();
  const [resolveRequest, { isLoading: isResolving }] =
    useResolveRequestMutation();
  const [closeRequest, { isLoading: isClosingMut }] = useCloseRequestMutation();
  const [assignExecutor, { isLoading: isAssigning }] =
    useAssignExecutorMutation();
  const [selfAssign, { isLoading: isSelfAssigning }] = useSelfAssignMutation();
  const [reassignExecutor, { isLoading: isReassigning }] =
    useReassignExecutorMutation();
  const [escalateRequest, { isLoading: isEscalating }] =
    useEscalateRequestMutation();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (isError || !request) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate({ to: "/service-request/queue/list" })}
          >
            <ArrowLeft />
            Back
          </Button>
        </div>
        <div className="rounded-xl border bg-card overflow-x-auto">
          <EmptyState
            variant="error"
            icon={AlertCircle}
            title="Failed to load ticket"
            description="It may have been deleted or you don't have access."
          />
        </div>
      </div>
    );
  }

  const caps = request.capabilities;
  const visibleTimeline =
    request.timeline?.filter((t) => t.status !== "hidden") ?? [];
  const isReassign = !!caps?.can_reassign_executor;

  // ─── Action handlers ──────────────────────────────────────────────────
  const handleAddComment = async () => {
    if (!newComment.trim()) return;
    try {
      await addComment({ id, body: newComment.trim() }).unwrap();
      toast.success("Comment added");
      setNewComment("");
    } catch (err) {
      toast.error(err, "Failed to add comment");
    }
  };
  const handleAddNote = async () => {
    if (!newNote.trim()) return;
    try {
      await addNote({ id, body: newNote.trim() }).unwrap();
      toast.success("Note added");
      setNewNote("");
    } catch (err) {
      toast.error(err, "Failed to add note");
    }
  };
  const handleFirstResponse = async () => {
    try {
      await firstResponse(id).unwrap();
      toast.success("First response recorded");
    } catch (err) {
      toast.error(err, "Failed to record first response");
    }
  };
  const handleSubmitForApproval = async () => {
    try {
      await submitForApproval(id).unwrap();
      toast.success("Sent for approval");
    } catch (err) {
      toast.error(err, "Failed to send for approval");
    }
  };
  const handleSelfAssign = async () => {
    try {
      await selfAssign(id).unwrap();
      toast.success("Ticket self-assigned");
    } catch (err) {
      toast.error(err, "Failed to self-assign");
    }
  };
  const handleAssign = async () => {
    if (!selectedExecutor) return;
    const mutation = isReassign ? reassignExecutor : assignExecutor;
    try {
      await mutation({
        id,
        executor_user_id: selectedExecutor,
        notes: assignmentNotes || "",
      }).unwrap();
      toast.success(isReassign ? "Executor reassigned" : "Executor assigned");
      setAssignModalOpen(false);
      setSelectedExecutor("");
      setAssignmentNotes("");
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
    if (!escalateTo || !escalateReason.trim()) return;
    try {
      await escalateRequest({
        id,
        escalate_to_user_id: escalateTo,
        reason: escalateReason,
      }).unwrap();
      toast.success("Ticket escalated");
      setEscalateModalOpen(false);
      setEscalateTo("");
      setEscalateReason("");
    } catch (err) {
      toast.error(err, "Failed to escalate ticket");
    }
  };
  const handleResolve = async () => {
    if (!resolutionNotes.trim()) return;
    try {
      await resolveRequest({
        id,
        resolution_notes: resolutionNotes.trim(),
      }).unwrap();
      toast.success("Ticket resolved");
      setResolveModalOpen(false);
      setResolutionNotes("");
    } catch (err) {
      toast.error(err, "Failed to resolve ticket");
    }
  };
  const handleClose = async () => {
    try {
      await closeRequest({
        id,
        closing_remarks: closingRemarks.trim() || "",
      }).unwrap();
      toast.success("Ticket closed");
      setCloseModalOpen(false);
      setClosingRemarks("");
    } catch (err) {
      toast.error(err, "Failed to close ticket");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate({ to: "/service-request/queue/list" })}
        >
          <ArrowLeft />
          Back
        </Button>
      </div>

      <div className="flex items-start justify-between gap-4">
        <PageHeader
          title={request.title}
          subtitle={`Submitted on ${formatDateTime(request.submitted_on)}`}
        />
        <div className="shrink-0">
          <StatusCell status={request.status} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Left column ─ main content */}
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardContent className="pt-6">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div>
                  <p className="text-xs text-muted-foreground">Ticket ID</p>
                  <p className="text-sm font-medium">{request.ticket_no}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Category</p>
                  <p className="text-sm font-medium">
                    {request.metadata?.category_name ??
                      request.metadata?.category_id ??
                      "—"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Priority</p>
                  <Badge
                    variant={
                      priorityVariant[request.priority?.toLowerCase()] ??
                      "default"
                    }
                    className="capitalize"
                  >
                    {request.priority}
                  </Badge>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Department</p>
                  <p className="text-sm font-medium">
                    {request.metadata?.department_name ??
                      request.metadata?.department_id ??
                      "—"}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Description</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm whitespace-pre-wrap">
                {request.description || (
                  <span className="text-muted-foreground italic">
                    No description provided.
                  </span>
                )}
              </p>
            </CardContent>
          </Card>

          {/* SLA */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Service Level Agreement
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-muted-foreground">
                    First Response Due
                  </p>
                  <p className="text-sm font-medium">
                    <Clock className="mr-1 inline h-3 w-3" />
                    {formatDateTime(request.first_response_due_by)}
                  </p>
                  {request.first_response_at && (
                    <p className="text-xs text-success mt-1">
                      <CircleCheck className="mr-1 inline h-3 w-3" />
                      Responded {formatDateTime(request.first_response_at)}
                    </p>
                  )}
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    Resolution Due
                  </p>
                  <p className="text-sm font-medium">
                    <Clock className="mr-1 inline h-3 w-3" />
                    {formatDateTime(request.resolution_due_by)}
                  </p>
                  {request.resolved_at && (
                    <p className="text-xs text-success mt-1">
                      <CircleCheck className="mr-1 inline h-3 w-3" />
                      Resolved {formatDateTime(request.resolved_at)}
                    </p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Tabs ─ Comments / Internal Notes / Activity */}
          <Card>
            <CardContent className="pt-6">
              <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="w-full justify-start">
                  <TabsTrigger value="comments" className="gap-2">
                    <MessageSquare className="size-4" />
                    Comments
                    {comments.length > 0 && (
                      <Badge variant="secondary" className="h-5 px-1.5 text-xs">
                        {comments.length}
                      </Badge>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="internal-notes" className="gap-2">
                    <StickyNote className="size-4" />
                    Internal Notes
                    {notes.length > 0 && (
                      <Badge variant="secondary" className="h-5 px-1.5 text-xs">
                        {notes.length}
                      </Badge>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="activity" className="gap-2">
                    <ActivityIcon className="size-4" />
                    Activity
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="comments" className="mt-4 space-y-4">
                  {comments.length === 0 && (
                    <p className="text-sm text-muted-foreground italic">
                      No comments yet.
                    </p>
                  )}
                  {comments.map((c) => (
                    <div key={c.id} className="rounded-xl border p-4">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-sm font-medium">
                          {c.author_name ?? c.author_user_id}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatDateTime(c.created_on)}
                        </span>
                      </div>
                      <p className="text-sm whitespace-pre-wrap">{c.body}</p>
                    </div>
                  ))}
                  <div className="flex gap-2">
                    <Input
                      placeholder="Type your comment here..."
                      value={newComment}
                      onChange={(e) => setNewComment(e.target.value)}
                      className="flex-1"
                    />
                    <Button
                      size="sm"
                      disabled={!newComment.trim() || isAddingComment}
                      onClick={handleAddComment}
                    >
                      {isAddingComment ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <Send />
                      )}
                      Add Comment
                    </Button>
                  </div>
                </TabsContent>

                <TabsContent value="internal-notes" className="mt-4 space-y-4">
                  {notes.length === 0 && (
                    <p className="text-sm text-muted-foreground italic">
                      No internal notes yet.
                    </p>
                  )}
                  {notes.map((n) => (
                    <div
                      key={n.id}
                      className="rounded-xl border border-badge-pending-text/20 bg-badge-pending-bg p-4"
                    >
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-sm font-medium">
                          {n.author_name ?? n.author_user_id}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatDateTime(n.created_on)}
                        </span>
                      </div>
                      <p className="text-sm whitespace-pre-wrap">{n.body}</p>
                    </div>
                  ))}
                  <div className="flex gap-2">
                    <Input
                      placeholder="Type your note here..."
                      value={newNote}
                      onChange={(e) => setNewNote(e.target.value)}
                      className="flex-1"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!newNote.trim() || isAddingNote}
                      onClick={handleAddNote}
                    >
                      {isAddingNote && <Loader2 className="animate-spin" />}
                      Add Internal Note
                    </Button>
                  </div>
                </TabsContent>

                <TabsContent value="activity" className="mt-4">
                  <div className="space-y-3">
                    {visibleTimeline.length === 0 ? (
                      <p className="text-sm text-muted-foreground italic">
                        No activity yet.
                      </p>
                    ) : (
                      visibleTimeline.map((step, idx) => (
                        <div
                          key={`${step.label}-${idx}`}
                          className="flex items-start gap-3 text-sm"
                        >
                          <div className="mt-1 h-2 w-2 rounded-full bg-muted-foreground" />
                          <div>
                            <p className="font-medium">{step.label}</p>
                            {step.detail && (
                              <p className="text-xs text-muted-foreground">
                                {step.detail}
                              </p>
                            )}
                            {step.timestamp && (
                              <p className="text-[10px] text-muted-foreground">
                                {formatDateTime(step.timestamp)}
                              </p>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>

        {/* Right column ─ requester + actions */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Requester</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <User className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">
                  {request.requester_name ?? request.requester_user_id}
                </span>
              </div>
            </CardContent>
          </Card>

          {request.executor_user_id && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Assigned Executor</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                <div className="flex items-center gap-2">
                  <User className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">
                    {request.executor_name ?? request.executor_user_id}
                  </span>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Actions — only renders buttons the user is allowed to use */}
          {caps &&
            (caps.can_first_response ||
              caps.can_submit_for_approval ||
              caps.can_self_assign ||
              caps.can_assign_executor ||
              caps.can_reassign_executor ||
              caps.can_resolve ||
              caps.can_close ||
              caps.can_escalate) && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Actions</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {caps.can_first_response && (
                    <Button
                      className="w-full justify-start"
                      size="sm"
                      disabled={isFirstResponse}
                      onClick={handleFirstResponse}
                    >
                      <CircleCheck />
                      {isFirstResponse ? "Marking..." : "Mark First Response"}
                    </Button>
                  )}
                  {caps.can_submit_for_approval && (
                    <Button
                      className="w-full justify-start"
                      size="sm"
                      variant="outline"
                      disabled={isSubmittingForApproval}
                      onClick={handleSubmitForApproval}
                    >
                      <AlertTriangle />
                      {isSubmittingForApproval
                        ? "Sending..."
                        : "Send for Approval"}
                    </Button>
                  )}
                  {caps.can_self_assign && (
                    <Button
                      className="w-full justify-start"
                      size="sm"
                      disabled={isSelfAssigning}
                      onClick={handleSelfAssign}
                    >
                      <User />
                      {isSelfAssigning ? "Assigning..." : "Self Assign"}
                    </Button>
                  )}
                  {(caps.can_assign_executor || caps.can_reassign_executor) && (
                    <Button
                      className="w-full justify-start"
                      size="sm"
                      variant="outline"
                      onClick={() => setAssignModalOpen(true)}
                    >
                      <User />
                      {isReassign ? "Reassign Executor" : "Assign Executor"}
                    </Button>
                  )}
                  {caps.can_resolve && (
                    <Button
                      className="w-full justify-start"
                      size="sm"
                      onClick={() => setResolveModalOpen(true)}
                    >
                      Resolve Ticket
                    </Button>
                  )}
                  {caps.can_close && (
                    <Button
                      className="w-full justify-start"
                      size="sm"
                      variant="destructive"
                      onClick={() => setCloseModalOpen(true)}
                    >
                      Close Ticket
                    </Button>
                  )}
                  {caps.can_escalate && (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 text-sm text-badge-pending-text hover:underline underline-offset-2"
                      onClick={() => setEscalateModalOpen(true)}
                    >
                      <AlertTriangle className="size-3.5 shrink-0" />
                      Escalate Ticket
                    </button>
                  )}
                </CardContent>
              </Card>
            )}
        </div>
      </div>

      {/* ─── Modals ─────────────────────────────────────────────────────── */}

      <Dialog open={assignModalOpen} onOpenChange={setAssignModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {isReassign ? "Reassign Executor" : "Assign Executor"}
            </DialogTitle>
            <DialogDescription>
              Pick an executor from your department to handle this ticket.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>
                Executor <span className="text-destructive">*</span>
              </Label>
              <Select
                value={selectedExecutor}
                onValueChange={setSelectedExecutor}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select Executor" />
                </SelectTrigger>
                <SelectContent>
                  {eligibleExecutors.map((e) => (
                    <SelectItem key={e.user_id} value={e.user_id}>
                      {/* Flagged, not hidden — see `previously_escalated_by`
                          in srmApi.ts. Assigning back to the person who
                          escalated it is allowed; they just should not be
                          picked by accident. */}
                      {e.previously_escalated_by
                        ? `${e.name} — escalated this earlier`
                        : e.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea
                placeholder="Optional notes for the executor"
                value={assignmentNotes}
                onChange={(e) => setAssignmentNotes(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignModalOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!selectedExecutor || isAssigning || isReassigning}
              onClick={handleAssign}
            >
              {(isAssigning || isReassigning) && (
                <Loader2 className="animate-spin" />
              )}
              {isReassign ? "Reassign" : "Assign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={escalateModalOpen} onOpenChange={setEscalateModalOpen}>
        <DialogContent>
          <DialogHeader>
            {/* Both strings used to say "Department Head". That was true when
                the head was the only possible target; escalation now goes to a
                primary executor on the ticket's category, who may be neither
                the head nor in that department at all. */}
            <DialogTitle>Escalate Ticket</DialogTitle>
            <DialogDescription>
              {escalationTargets.length === 1
                ? "This ticket will be handed to the primary executor shown below. Record a reason."
                : "Hand this ticket to another primary executor on its category, and record a reason."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>
                Escalate To <span className="text-destructive">*</span>
              </Label>
              {escalationTargets.length === 0 ? (
                // Nobody eligible. The endpoint answers 200 with an empty list
                // and the cause in `reason`, so render that rather than an
                // empty dropdown the user can only stare at.
                <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                  {noEscalationTargetReason
                    ? `This ticket cannot be escalated — ${noEscalationTargetReason}`
                    : "No escalation target available"}
                </div>
              ) : escalationTargets.length === 1 ? (
                // Exactly one eligible primary — render a read-only badge
                // instead of a picker. escalateTo is auto-set by the effect
                // above.
                <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
                  <User className="size-4 text-muted-foreground" />
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
                <Select value={escalateTo} onValueChange={setEscalateTo}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select target" />
                  </SelectTrigger>
                  <SelectContent>
                    {escalationTargets.map((t) => {
                      const label = t.name ?? t.user_id;
                      return (
                        <SelectItem key={t.user_id} value={t.user_id}>
                          {t.email ? `${label} (${t.email})` : label}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="space-y-2">
              <Label>
                Reason <span className="text-destructive">*</span>
              </Label>
              <Textarea
                placeholder="Why does this need to be escalated?"
                value={escalateReason}
                onChange={(e) => setEscalateReason(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEscalateModalOpen(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={!escalateTo || !escalateReason.trim() || isEscalating}
              onClick={handleEscalate}
            >
              {isEscalating && <Loader2 className="animate-spin" />}
              Escalate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={resolveModalOpen} onOpenChange={setResolveModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resolve Ticket</DialogTitle>
            <DialogDescription>
              Describe how you resolved the ticket. The requester will see
              this.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>
              Resolution Notes <span className="text-destructive">*</span>
            </Label>
            <Textarea
              placeholder="e.g. Installed Adobe CC, verified login, sent welcome email."
              value={resolutionNotes}
              onChange={(e) => setResolutionNotes(e.target.value)}
              rows={5}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setResolveModalOpen(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={!resolutionNotes.trim() || isResolving}
              onClick={handleResolve}
            >
              {isResolving && <Loader2 className="animate-spin" />}
              Resolve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={closeModalOpen}
        onOpenChange={setCloseModalOpen}
        title="Close Ticket"
        description="This will close the ticket permanently. Closed tickets are read-only."
        confirmLabel={isClosingMut ? "Closing..." : "Close Ticket"}
        variant="destructive"
        onConfirm={handleClose}
      />
    </div>
  );
};
