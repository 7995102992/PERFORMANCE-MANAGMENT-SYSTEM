import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, LockOpen, Trash2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { useAppSelector } from "@/store";
import { useAuth } from "@/hooks/use-auth";
import {
  useGetEmployeePastSubmissionOverridesQuery,
  useCreateEmployeePastSubmissionOverrideMutation,
  useDeleteEmployeePastSubmissionOverrideMutation,
} from "@/store/api/timesheetApi";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "8 Sep", adding the year only when it differs from the month being reopened. */
const untilLabel = (iso: string, monthYear: number): string | null => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const short = MONTHS[d.getMonth()].slice(0, 3);
  return d.getFullYear() === monthYear
    ? `${d.getDate()} ${short}`
    : `${d.getDate()} ${short} ${d.getFullYear()}`;
};

/**
 * Reopens one employee's closed month, from that employee's month view.
 *
 * A grant is per employee + month but lifts the cutoff only on the GRANTING
 * manager's projects, so this never says "August is open" — it lists who
 * granted what. Two managers can each grant for the same month and the
 * employee refiles against the union, which is why existing grants render as
 * separate rows rather than one on/off state.
 *
 * Replaces a project-level dialog that picked a project first. Reopening is a
 * decision about a person's late month, not about a project, and the API moved
 * to match.
 */
export function ReopenMonthDialog({
  open,
  onOpenChange,
  userId,
  userName,
  /** 0-11, matching JS Date — the month the sheet is showing. */
  month,
  year,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  userName?: string | null;
  month: number;
  year: number;
}) {
  const [reason, setReason] = useState("");
  const currentUserId = useAppSelector((s) => s.auth.user?.id ?? "");
  const { isOrgAdmin } = useAuth();

  // Every live grant for this employee, from any manager — not just ours.
  const { data: overrides, isFetching } =
    useGetEmployeePastSubmissionOverridesQuery(userId, {
      skip: !open || !userId,
    });

  const [createOverride, { isLoading: isReopening }] =
    useCreateEmployeePastSubmissionOverrideMutation();
  const [deleteOverride, { isLoading: isRemoving }] =
    useDeleteEmployeePastSubmissionOverrideMutation();

  // The API takes 1-12; the sheet works in JS months.
  const apiMonth = month + 1;
  const monthLabel = `${MONTHS[month]} ${year}`;

  const grantsThisMonth = (overrides ?? []).filter(
    (o) => o.year === year && o.month === apiMonth,
  );
  const myGrant = grantsThisMonth.find((o) => o.created_by === currentUserId);

  const handleReopen = async () => {
    try {
      await createOverride({
        userId,
        year,
        month: apiMonth,
        reason: reason.trim() || null,
      }).unwrap();
      // Not "the month is open" — it's open for this manager's projects only.
      toast.success(`${monthLabel} reopened for your projects`);
      setReason("");
    } catch (err) {
      toast.error(err, "Couldn't reopen this month");
    }
  };

  const handleRemove = async () => {
    try {
      await deleteOverride({ userId, year, month: apiMonth }).unwrap();
      toast.success(`Your grant for ${monthLabel} was removed`);
    } catch (err) {
      toast.error(err, "Couldn't remove this grant");
    }
  };

  const busy = isReopening || isRemoving;

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <LockOpen className="size-5 text-warning" />
            <DialogTitle>Reopen {monthLabel}?</DialogTitle>
          </div>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <p className="text-sm text-muted-foreground">
            {userName ?? "This employee"} will be able to file and submit time
            for {monthLabel} again — but only against{" "}
            <span className="font-medium text-foreground">your projects</span>.
            Time booked to a project nobody has reopened will still be refused.
            The grant lapses after a week — you can always reopen again.
          </p>

          {/* Existing grants, from every manager. Shown because the month may
              already be open for someone else's projects, which changes what
              this button adds. */}
          {isFetching ? (
            <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Checking existing grants…
            </div>
          ) : grantsThisMonth.length > 0 ? (
            <div className="space-y-2 rounded-xl border bg-muted/30 px-3 py-2.5">
              <p className="text-xs font-semibold text-foreground">
                Already reopened by
              </p>
              {grantsThisMonth.map((o) => {
                const mine = o.created_by === currentUserId;
                return (
                  <div
                    key={o.id}
                    className="flex items-start justify-between gap-3 text-xs"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-foreground">
                        {o.created_by_name ?? "A manager"}
                        {mine && " (you)"}
                      </p>
                      <p className="text-muted-foreground">
                        {/* Empty project_ids is an ADMIN grant covering
                            everything — never "no projects". */}
                        {(o.project_ids?.length ?? 0) === 0
                          ? "All projects"
                          : `${o.project_ids!.length} project${o.project_ids!.length === 1 ? "" : "s"}`}
                        {o.reason ? ` · ${o.reason}` : ""}
                      </p>
                      {/* A grant lapses a week after it's made and vanishes
                          from the GET, so this is the only place its deadline
                          is visible. */}
                      {o.expires_at && untilLabel(o.expires_at, year) && (
                        <p className="text-muted-foreground">
                          Open until {untilLabel(o.expires_at, year)}
                        </p>
                      )}
                    </div>
                    {/* DELETE only removes the caller's own grant, so the
                        control only exists on rows they can actually act on. */}
                    {(mine || isOrgAdmin) && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 shrink-0"
                        disabled={busy}
                        onClick={handleRemove}
                        title="Remove your grant"
                      >
                        <Trash2 className="size-3.5 text-destructive" />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}

          {!myGrant && (
            <div className="space-y-2">
              <Label htmlFor="reopen-reason">
                Reason{" "}
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              </Label>
              <Textarea
                id="reopen-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this month being reopened?"
                rows={2}
                className="resize-none"
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {myGrant ? "Done" : "Cancel"}
          </Button>
          {/* Re-granting is safe and useful — it refreshes the project
              snapshot for a manager who has since picked up another project. */}
          <Button disabled={busy} onClick={handleReopen}>
            {isReopening && <Loader2 className="mr-1 size-4 animate-spin" />}
            {myGrant ? "Refresh my grant" : "Reopen month"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
