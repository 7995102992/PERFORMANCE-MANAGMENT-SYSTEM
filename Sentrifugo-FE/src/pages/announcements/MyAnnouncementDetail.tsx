import { useNavigate, useParams } from "@tanstack/react-router";
import {
  AlertCircle,
  ArrowLeft,
  Download,
  FileText,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/EmptyState";
import { RichText } from "@/components/shared/RichText";
import {
  useGetMyAnnouncementQuery,
  type AnnouncementAttachment,
} from "@/store/api/announcementsApi";
import { downloadAuthed, openAuthed } from "@/lib/download";
import { toast } from "@/lib/toast";

// Employee attachment route — the BE re-checks targeting before streaming, so
// holding an asset_id is never on its own an entitlement.
const MY_ANNOUNCEMENTS_BASE = `${((import.meta.env.VITE_IAM_BASE_URL as string) ?? "").replace(/\/+$/, "")}/announcements/my-announcements`;

function formatFileSize(bytes: number): string {
  if (!bytes) return "0 KB";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const formatDate = (value?: string | null) =>
  value
    ? new Date(value).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "—";

/**
 * Read-only announcement detail for an employee.
 *
 * Same layout as the admin detail page, minus every action: publishing,
 * editing and unpublishing all live on the admin side. A 404 here is the BE
 * saying the caller is not targeted (or it is still a draft) — both collapse
 * into the same "not available" state, which is the point.
 */
const MyAnnouncementDetail = () => {
  const navigate = useNavigate();
  const { announcementId } = useParams({ strict: false }) as {
    announcementId: string;
  };
  const {
    data: announcement,
    isLoading,
    isError,
  } = useGetMyAnnouncementQuery(announcementId, { skip: !announcementId });

  // Back goes to the employee feed, which is where the breadcrumb places this
  // page (Dashboard > Announcements > title). The dashboard card is only one
  // of the two ways in, and the feed is the nearer parent from either.
  const backToFeed = () => navigate({ to: "/my-announcements" });

  const attachmentUrl = (att: AnnouncementAttachment) =>
    `${MY_ANNOUNCEMENTS_BASE}/${announcementId}/attachments/${att.asset_id}/download`;

  const preview = async (att: AnnouncementAttachment) => {
    try {
      await openAuthed(attachmentUrl(att));
    } catch (err) {
      toast.error(err, "Could not open the attachment.");
    }
  };

  const download = async (att: AnnouncementAttachment) => {
    try {
      await downloadAuthed(attachmentUrl(att), att.file_name);
    } catch (err) {
      toast.error(err, "Could not download the attachment.");
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
          onClick={backToFeed}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="rounded-xl border bg-card">
          <EmptyState
            variant="error"
            icon={AlertCircle}
            title="Announcement not available"
            description="It may have been withdrawn, or it is not shared with you."
          />
        </div>
      </div>
    );
  }

  const departmentNames = announcement.department_names ?? [];
  const businessUnitNames = announcement.business_unit_names ?? [];
  const attachments = announcement.attachments ?? [];

  return (
    <div className="space-y-6">
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        aria-label="Back to announcements"
        onClick={backToFeed}
      >
        <ArrowLeft className="size-4" />
      </Button>

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
                ? "Everyone in the organisation"
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
                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        onClick={() => preview(att)}
                        title={`View ${att.file_name}`}
                        className="block max-w-full truncate text-left text-sm text-foreground hover:text-primary hover:underline"
                      >
                        {att.file_name}
                      </button>
                      <p className="text-xs text-muted-foreground">
                        {formatFileSize(att.size)}
                      </p>
                    </div>
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
    </div>
  );
};

export default MyAnnouncementDetail;
