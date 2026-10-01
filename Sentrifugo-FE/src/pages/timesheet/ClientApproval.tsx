import { useState, useEffect } from "react";
import { useSearch } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Loader2, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { AuthLayout } from "@/layouts/AuthLayout";

const BASE_URL = (import.meta.env.VITE_TIMESHEET_BASE_URL ?? "").replace(
  /\/$/,
  "",
);

type Action = "approve" | "reject" | "approve_all" | "reject_all";
type Stage =
  | "form"
  | "loading"
  | "success-approved"
  | "success-rejected"
  | "success-bulk"
  | "error";
type ErrorKind = "expired" | "used" | "actioned" | "generic";

interface BulkResult {
  timesheet_id: string;
  status: "approved" | "skipped";
  reason?: string;
}

const ERROR_MESSAGES: Record<ErrorKind, string> = {
  expired:
    "This approval link has expired (valid 7 days). Please contact your administrator for a new link.",
  used: "This link has already been used.",
  actioned:
    "This timesheet has already been actioned. No further changes can be made via this link.",
  generic: "Something went wrong. Please contact your administrator.",
};

const resolveError = (
  body: { code?: string; detail?: string },
  wasSuccessful?: boolean,
): ErrorKind => {
  if (body.code === "TOKEN_EXPIRED") return "expired";
  if (body.code === "INVALID_TOKEN") {
    // If a prior successful call stamped used_at, back-button retry will hit INVALID_TOKEN —
    // treat it as "already actioned" rather than a bad link.
    if (
      wasSuccessful ||
      body.detail?.toLowerCase().includes("used") ||
      body.detail?.toLowerCase().includes("already")
    )
      return "actioned";
    return "used";
  }
  if (body.detail?.toLowerCase().includes("already")) return "actioned";
  return "generic";
};

const isBulk = (action: Action) =>
  action === "approve_all" || action === "reject_all";
const isReject = (action: Action) =>
  action === "reject" || action === "reject_all";

export default function ClientApproval() {
  const search = useSearch({ strict: false }) as {
    token?: string;
    timesheet_id?: string;
    action?: string;
  };

  const token = search.token ?? "";
  const timesheetId = search.timesheet_id ?? "";
  const action: Action = (
    ["approve", "reject", "approve_all", "reject_all"].includes(
      search.action ?? "",
    )
      ? search.action
      : "approve"
  ) as Action;

  const [stage, setStage] = useState<Stage>("form");
  const [comments, setComments] = useState("");
  const [errorKind, setErrorKind] = useState<ErrorKind>("generic");
  const [bulkResults, setBulkResults] = useState<BulkResult[]>([]);
  const [bulkAction, setBulkAction] = useState<"approve_all" | "reject_all">(
    "approve_all",
  );
  const [everSucceeded, setEverSucceeded] = useState(false);
  const [countdown, setCountdown] = useState(3);

  const isTerminal = stage !== "form" && stage !== "loading";

  useEffect(() => {
    if (!isTerminal) return;
    setCountdown(3);
    const interval = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(interval);
          window.close();
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [isTerminal]);

  const handleApprove = async () => {
    setStage("loading");
    try {
      const res = await fetch(
        `${BASE_URL}/public/timesheets/${timesheetId}/client-approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, comments: null }),
        },
      );
      if (res.ok) {
        setEverSucceeded(true);
        setStage("success-approved");
      } else {
        const body = await res.json().catch(() => ({}));
        setErrorKind(resolveError(body, everSucceeded));
        setStage("error");
      }
    } catch {
      setErrorKind("generic");
      setStage("error");
    }
  };

  const handleReject = async () => {
    if (!comments.trim()) return;
    setStage("loading");
    try {
      const res = await fetch(
        `${BASE_URL}/public/timesheets/${timesheetId}/client-reject`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, comments: comments.trim() }),
        },
      );
      if (res.ok) {
        setEverSucceeded(true);
        setStage("success-rejected");
      } else {
        const body = await res.json().catch(() => ({}));
        setErrorKind(resolveError(body, everSucceeded));
        setStage("error");
      }
    } catch {
      setErrorKind("generic");
      setStage("error");
    }
  };

  const handleBulkApprove = async () => {
    setStage("loading");
    try {
      const res = await fetch(`${BASE_URL}/public/client-bulk-approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, comments: null }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        setEverSucceeded(true);
        setBulkResults(data.results ?? []);
        setBulkAction("approve_all");
        setStage("success-bulk");
      } else {
        const body = await res.json().catch(() => ({}));
        setErrorKind(resolveError(body, everSucceeded));
        setStage("error");
      }
    } catch {
      setErrorKind("generic");
      setStage("error");
    }
  };

  const handleBulkReject = async () => {
    if (!comments.trim()) return;
    setStage("loading");
    try {
      const res = await fetch(`${BASE_URL}/public/client-bulk-reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, comments: comments.trim() }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        setEverSucceeded(true);
        setBulkResults(data.results ?? []);
        setBulkAction("reject_all");
        setStage("success-bulk");
      } else {
        const body = await res.json().catch(() => ({}));
        setErrorKind(resolveError(body, everSucceeded));
        setStage("error");
      }
    } catch {
      setErrorKind("generic");
      setStage("error");
    }
  };

  // ── Loading ──────────────────────────────────────────────────────────────
  if (stage === "loading") {
    return (
      <AuthLayout
        title="Processing…"
        description="Please wait while we record your response."
      >
        <div className="flex justify-center py-2">
          <Loader2 className="size-8 animate-spin text-primary" />
        </div>
      </AuthLayout>
    );
  }

  // ── Success — single approve ─────────────────────────────────────────────
  if (stage === "success-approved") {
    return (
      <AuthLayout
        title="Timesheet Approved"
        description="The timesheet has been approved successfully. The employee will be notified."
        headerIcon={<CheckCircle2 className="h-10 w-10 text-success" />}
      >
        <p className="text-center text-sm text-muted-foreground">
          Closing this tab in {countdown} second{countdown !== 1 ? "s" : ""}…
        </p>
      </AuthLayout>
    );
  }

  // ── Success — single reject ──────────────────────────────────────────────
  if (stage === "success-rejected") {
    return (
      <AuthLayout
        title="Timesheet Rejected"
        description="The timesheet has been rejected. The employee will be notified to make corrections."
        headerIcon={<XCircle className="h-10 w-10 text-muted-foreground" />}
      >
        <p className="text-center text-sm text-muted-foreground">
          Closing this tab in {countdown} second{countdown !== 1 ? "s" : ""}…
        </p>
      </AuthLayout>
    );
  }

  // ── Success — bulk ───────────────────────────────────────────────────────
  if (stage === "success-bulk") {
    const approved = bulkResults.filter((r) => r.status === "approved").length;
    const skipped = bulkResults.filter((r) => r.status === "skipped").length;
    const isApproveAll = bulkAction === "approve_all";
    return (
      <AuthLayout
        title={
          isApproveAll ? "All Timesheets Approved" : "All Timesheets Rejected"
        }
        description={
          isApproveAll
            ? "The timesheets have been approved. All employees will be notified."
            : "The timesheets have been rejected. Employees will be notified to make corrections."
        }
        headerIcon={
          isApproveAll ? (
            <CheckCircle2 className="h-10 w-10 text-success" />
          ) : (
            <XCircle className="h-10 w-10 text-muted-foreground" />
          )
        }
      >
        <div className="space-y-3">
          {bulkResults.length > 0 && (
            <div className="rounded-xl border bg-muted/40 px-4 py-3 space-y-1 text-sm">
              {approved > 0 && (
                <div className="flex items-center gap-2 text-success">
                  <CheckCircle2 className="size-4 shrink-0" />
                  <span>
                    {approved} timesheet{approved !== 1 ? "s" : ""}{" "}
                    {isApproveAll ? "approved" : "rejected"}
                  </span>
                </div>
              )}
              {skipped > 0 && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <AlertTriangle className="size-4 shrink-0" />
                  <span>
                    {skipped} skipped (already actioned or ineligible)
                  </span>
                </div>
              )}
            </div>
          )}
          <p className="text-center text-sm text-muted-foreground">
            Closing this tab in {countdown} second{countdown !== 1 ? "s" : ""}…
          </p>
        </div>
      </AuthLayout>
    );
  }

  // ── Error ────────────────────────────────────────────────────────────────
  if (stage === "error") {
    return (
      <AuthLayout
        title="Unable to Process"
        description={ERROR_MESSAGES[errorKind]}
        headerIcon={<AlertTriangle className="h-10 w-10 text-destructive" />}
      >
        <p className="text-center text-sm text-muted-foreground">
          Closing this tab in {countdown} second{countdown !== 1 ? "s" : ""}…
        </p>
      </AuthLayout>
    );
  }

  // ── Form — approve (single) ──────────────────────────────────────────────
  if (action === "approve") {
    return (
      <AuthLayout
        title="Approve Timesheet"
        description="You are about to approve this timesheet. Once confirmed, the employee will be notified and the record will be locked."
        headerIcon={<CheckCircle2 className="h-10 w-10 text-success" />}
      >
        <Button className="w-full" onClick={handleApprove}>
          Confirm Approve
        </Button>
      </AuthLayout>
    );
  }

  // ── Form — approve_all ───────────────────────────────────────────────────
  if (action === "approve_all") {
    return (
      <AuthLayout
        title="Approve All Timesheets"
        description="You are about to approve all pending timesheets in this submission. All employees will be notified once confirmed."
        headerIcon={<CheckCircle2 className="h-10 w-10 text-success" />}
      >
        <Button
          className="w-full"
          onClick={handleBulkApprove}
        >
          Confirm Approve All
        </Button>
      </AuthLayout>
    );
  }

  // ── Form — reject (single or bulk) ──────────────────────────────────────
  const isBulkReject = action === "reject_all";
  return (
    <AuthLayout
      title={isBulkReject ? "Reject All Timesheets" : "Reject Timesheet"}
      description={
        isBulkReject
          ? "Please provide a reason for rejecting all timesheets. All employees will receive this feedback."
          : "Please provide a reason for rejection. The employee will receive this feedback."
      }
      headerIcon={<XCircle className="h-10 w-10 text-destructive" />}
    >
      <div className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="comments">
            Reason for rejection <span className="text-destructive">*</span>
          </Label>
          <Textarea
            id="comments"
            value={comments}
            onChange={(e) => setComments(e.target.value)}
            placeholder="Explain why the timesheet(s) are being rejected…"
            rows={4}
            className="resize-none"
          />
        </div>
        <Button
          variant="outline"
          className="w-full text-destructive border-destructive hover:bg-destructive/10"
          onClick={isBulkReject ? handleBulkReject : handleReject}
          disabled={!comments.trim()}
        >
          {isBulkReject ? "Submit Rejection for All" : "Submit Rejection"}
        </Button>
      </div>
    </AuthLayout>
  );
}
