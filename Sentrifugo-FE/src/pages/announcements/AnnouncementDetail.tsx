import { useNavigate, useParams } from "@tanstack/react-router";
import {
  AlertCircle,
  ArrowLeft,
  Download,
  FileText,
  Loader2,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/EmptyState";
import { RichText } from "@/components/shared/RichText";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import {
  useGetAnnouncementQuery,
  useUnpublishAnnouncementMutation,
  type AnnouncementAttachment,
} from "@/store/api/announcementsApi";
import { downloadAuthed, openAuthed } from "@/lib/download";
import { toast } from "@/lib/toast";
import { useState } from "react";

// Admin attachment route — authenticated proxy, so both preview and download
// go through the token-aware helpers rather than window.open.
const ANNOUNCEMENTS_BASE = `${((import.meta.env.VITE_IAM_BASE_URL as string) ?? "").replace(/\/+$/, "")}/announcements`;

const formatDate = (value?: string | null) =>
  value
    ? new Date(value).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "—";

/**
 * Read-only detail page for a PUBLISHED announcement.
 *
 * Replaces the old read-only dialog: an announcement is a document, and a
 * document that people are asked to read gets a page and a URL they can be
 * pointed at, not a modal that vanishes on a backdrop click.
 *
 * A published record is immutable server-side (the BE 409s on PATCH), so the
 * only action offered here is Unpublish — the way back to an editable draft.
 */
const AnnouncementDetail = () => {
  const navigate = useNavigate();
  const { announcementId } = useParams({ strict: false }) as {
    announcementId: string;
  };
  const [unpublishOpen, setUnpublishOpen] = useState(false);

  const {
    data: announcement,
    isLoading,
    isError,
  } = useGetAnnouncementQuery(announcementId, { skip: !announcementId });
  const [unpublishAnnouncement] = useUnpublishAnnouncementMutation();

  const backToList = () => navigate({ to: "/announcements" });

  const preview = async (att: AnnouncementAttachment) => {
    try {
      await openAuthed(
        `${ANNOUNCEMENTS_BASE}/${announcementId}/attachments/${att.asset_id}/download`,
      );
    } catch (err) {
      toast.error(err, "Could not open the attachment.");
    }
  };

  const download = async (att: AnnouncementAttachment) => {
    try {
      await downloadAuthed(
        `${ANNOUNCEMENTS_BASE}/${announcementId}/attachments/${att.asset_id}/download`,
        att.file_name,
      );
    } catch (err) {
      toast.error(err, "Could not download the attachment.");
    }
  };

  const handleUnpublish = async () => {
    try {
      await unpublishAnnouncement(announcementId).unwrap();
      toast.success("Announcement moved back to draft");
      backToList();
    } catch (err) {
      toast.error(err, "Failed to unpublish announcement");
    } finally {
      setUnpublishOpen(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError || !announcement) {
    return (
      <div className="space-y-6">
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label="Back to announcements"
          onClick={backToList}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="rounded-xl border bg-card">
          <EmptyState
            variant="error"
            icon={AlertCircle}
            title="Announcement not found"
            description="It may have been deleted."
          />
        </div>
      </div>
    );
  }

  const departmentNames = announcement.department_names ?? [];
  const businessUnitNames = announcement.business_unit_names ?? [];
  const attachments = announcement.attachments ?? [];
  const isPublished = announcement.status === "published";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label="Back to announcements"
          onClick={backToList}
        >
          <ArrowLeft className="size-4" />
        </Button>
        {isPublished && (
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => setUnpublishOpen(true)}
          >
            <Undo2 className="size-4" />
            Unpublish
          </Button>
        )}
      </div>

      <div className="rounded-xl border bg-card">
        {/* Title block — name, then the posted date and business units on one
            meta line. */}
        <div className="border-b px-6 py-5">
          <h1 className="text-lg font-semibold text-foreground">
            {announcement.title}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatDate(announcement.posted_date)}
            {businessUnitNames.length > 0 && (
              <>
                <span className="mx-2">•</span>
                {businessUnitNames.join(", ")}
              </>
            )}
          </p>
        </div>

        <div className="space-y-6 px-6 py-5">
          <div>
            <p className="text-xs text-muted-foreground">Departments</p>
            <p className="mt-1.5 text-sm text-foreground">
              {departmentNames.length === 0
                ? "Organisation-wide"
                : departmentNames.join(", ")}
            </p>
          </div>

          <div>
            <p className="text-xs text-muted-foreground">Description</p>
            <RichText
              variant="block"
              html={announcement.description}
              className="mt-1.5 text-sm text-foreground"
            />
          </div>

          {attachments.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground">Attachments</p>
              <div className="mt-1.5 space-y-2">
                {attachments.map((att) => (
                  <div
                    key={att.asset_id}
                    className="flex items-center gap-3 rounded-lg border px-3 py-2"
                  >
                    <FileText className="size-4 shrink-0 text-info" />
                    <button
                      type="button"
                      onClick={() => preview(att)}
                      title={`View ${att.file_name}`}
                      className="min-w-0 flex-1 truncate text-left text-sm text-foreground hover:text-primary hover:underline"
                    >
                      {att.file_name}
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0 text-muted-foreground"
                      aria-label={`Download ${att.file_name}`}
                      onClick={() => download(att)}
                    >
                      <Download className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={unpublishOpen}
        onOpenChange={setUnpublishOpen}
        title="Unpublish announcement"
        description={`"${announcement.title}" will be moved back to draft and will no longer appear on employee dashboards.`}
        confirmLabel="Unpublish"
        onConfirm={handleUnpublish}
      />
    </div>
  );
};

export default AnnouncementDetail;
