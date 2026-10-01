import { useCallback, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { AlertCircle, Loader2, Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import { AttachmentDropzone } from "@/components/shared/AttachmentDropzone";
import { RichTextEditor } from "@/components/shared/RichTextEditor";
import { richTextToPlainText } from "@/lib/rich-text";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import {
  useCreateAnnouncementMutation,
  useGetAnnouncementQuery,
  usePublishAnnouncementMutation,
  useUpdateAnnouncementMutation,
} from "@/store/api/announcementsApi";
import type {
  AnnouncementAttachment,
  AnnouncementCreate,
} from "@/store/api/announcementsApi";
import {
  useGetBusinessUnitsQuery,
  useGetDepartmentsQuery,
  useUploadAssetMutation,
} from "@/store/api/iamApi";
import { cn, deptLabel } from "@/lib/utils";
import { openAuthed, openLocalFile } from "@/lib/download";
import { toast } from "@/lib/toast";

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 5000;
/** Object-storage bucket folder for announcement attachments. */
const ASSET_FOLDER = "announcements";
/** Admin attachment route — authenticated, so previews go through openAuthed. */
const ANNOUNCEMENTS_BASE = `${((import.meta.env.VITE_IAM_BASE_URL as string) ?? "").replace(/\/+$/, "")}/announcements`;

const announcementSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Title is required")
    .max(TITLE_MAX, `Title must be ${TITLE_MAX} characters or fewer`),
  // The description is rich text, so both rules are measured on the text the
  // reader sees — `<p><strong>Hi</strong></p>` is two characters, not
  // twenty-seven.
  description: z
    .string()
    .refine(
      (v) => richTextToPlainText(v).length > 0,
      "Description is required",
    )
    .refine(
      (v) => richTextToPlainText(v).length <= DESCRIPTION_MAX,
      `Description must be ${DESCRIPTION_MAX} characters or fewer`,
    ),
  // Audience is inclusive-by-omission, matching the BE: an empty list means
  // EVERY business unit / department, not "nobody". Leaving both empty is how
  // an organisation-wide announcement is made — and unlike ticking every option
  // by hand, it keeps reaching units and departments created later.
  businessUnitIds: z.array(z.string()),
  departmentIds: z.array(z.string()),
});

type AnnouncementFormValues = z.infer<typeof announcementSchema>;

const EMPTY_FORM: AnnouncementFormValues = {
  title: "",
  description: "",
  businessUnitIds: [],
  departmentIds: [],
};

function formatFileSize(bytes: number): string {
  if (!bytes) return "0 KB";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editId?: string | null;
}

export const AnnouncementForm = ({ open, onOpenChange, editId }: Props) => {
  const isEditing = !!editId;

  const { data: announcement, isLoading } = useGetAnnouncementQuery(editId!, {
    skip: !editId,
  });
  const {
    data: businessUnits = [],
    isLoading: businessUnitsLoading,
    isError: businessUnitsError,
  } = useGetBusinessUnitsQuery({ is_active: true });
  const businessUnitOptions = businessUnits
    .map((bu) => ({ label: bu.business_unit_name, value: bu.id }))
    .filter((o) => o.label && o.value);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    trigger,
    formState: { errors, isDirty },
  } = useForm<AnnouncementFormValues>({
    resolver: zodResolver(announcementSchema),
    mode: "onBlur",
    defaultValues: EMPTY_FORM,
  });

  // Departments are business-unit scoped, and targeting ANDs the two lists — so
  // offering a department that sits outside every selected unit would let an
  // author build an audience of nobody. Narrow the options to the chosen units;
  // with none chosen the announcement spans every unit, so all are offered.
  const selectedBusinessUnitIds = watch("businessUnitIds");
  const {
    data: departments = [],
    isLoading: departmentsLoading,
    isFetching: departmentsFetching,
    isError: departmentsError,
  } = useGetDepartmentsQuery({
    is_active: true,
    business_unit_ids: selectedBusinessUnitIds.length
      ? selectedBusinessUnitIds
      : undefined,
  });

  const departmentOptions = departments
    .map((d) => ({ label: deptLabel(d), value: d.id }))
    .filter((o) => o.label && o.value);

  // Attachments live outside react-hook-form: already-uploaded ones carry an
  // asset_id, freshly picked ones are still local File handles that only get
  // uploaded on save. `attachmentsDirty` folds them into the dirty check.
  const [existingAttachments, setExistingAttachments] = useState<
    AnnouncementAttachment[]
  >([]);
  const [newFiles, setNewFiles] = useState<File[]>([]);
  const [attachmentsDirty, setAttachmentsDirty] = useState(false);

  const [populated, setPopulated] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  // Holds the validated payload while the org-wide publish confirmation is up,
  // so confirming submits exactly what was validated rather than re-reading the
  // form.
  const [orgWidePending, setOrgWidePending] =
    useState<AnnouncementFormValues | null>(null);

  const dirty = isDirty || attachmentsDirty;

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && dirty) {
        setDiscardOpen(true);
      } else {
        onOpenChange(next);
      }
    },
    [dirty, onOpenChange],
  );

  // Always start blank whenever the sheet opens/closes or the target record
  // changes — edit mode re-populates in the effect below.
  useEffect(() => {
    reset(EMPTY_FORM);
    setExistingAttachments([]);
    setNewFiles([]);
    setAttachmentsDirty(false);
    setPopulated(false);
    // A confirmation left open when the sheet closed must not carry a stale
    // payload into the next announcement.
    setOrgWidePending(null);
  }, [open, editId, reset]);

  useEffect(() => {
    if (
      populated ||
      !open ||
      !editId ||
      !announcement ||
      // Ignore a cached result belonging to a previously opened announcement.
      announcement.id !== editId
    )
      return;
    reset({
      title: announcement.title,
      description: announcement.description,
      businessUnitIds: announcement.business_unit_ids ?? [],
      departmentIds: announcement.department_ids ?? [],
    });
    setExistingAttachments(announcement.attachments ?? []);
    setNewFiles([]);
    setAttachmentsDirty(false);
    setPopulated(true);
  }, [announcement, populated, reset, open, editId]);

  const [createAnnouncement] = useCreateAnnouncementMutation();
  const [updateAnnouncement] = useUpdateAnnouncementMutation();
  const [publishAnnouncement] = usePublishAnnouncementMutation();
  const [uploadAsset] = useUploadAssetMutation();

  const selectedDepartmentIds = watch("departmentIds");

  // Deselecting a business unit can strand a department that only existed under
  // it. Left in place it would still travel in the payload and the BE would
  // reject the save, so drop the stranded ones as soon as the options narrow.
  // Only acts on a settled result — mid-refetch the list is momentarily empty,
  // and pruning against that would wipe a valid selection.
  useEffect(() => {
    if (departmentsLoading || departmentsFetching || departmentsError) return;
    const allowed = new Set(departments.map((d) => d.id));
    const kept = selectedDepartmentIds.filter((id) => allowed.has(id));
    if (kept.length !== selectedDepartmentIds.length) {
      setValue("departmentIds", kept, {
        shouldDirty: true,
        shouldValidate: true,
      });
    }
  }, [
    departments,
    departmentsLoading,
    departmentsFetching,
    departmentsError,
    selectedDepartmentIds,
    setValue,
  ]);


  /**
   * Preview an already-uploaded attachment. The endpoint is authenticated, so
   * the file is fetched with the bearer token and shown from a blob URL —
   * `window.open` on the raw URL would 401.
   */
  const viewExisting = async (att: AnnouncementAttachment) => {
    if (!editId) return;
    try {
      await openAuthed(
        `${ANNOUNCEMENTS_BASE}/${editId}/attachments/${att.asset_id}/download`,
      );
    } catch (err) {
      toast.error(err, "Could not open the attachment.");
    }
  };

  const removeExisting = (assetId: string) => {
    setExistingAttachments((prev) => prev.filter((a) => a.asset_id !== assetId));
    setAttachmentsDirty(true);
  };

  const removeNewFile = (index: number) => {
    setNewFiles((prev) => prev.filter((_, i) => i !== index));
    setAttachmentsDirty(true);
  };

  /** Uploads each pending file to /assets/upload and returns the wire shape. */
  const uploadPendingFiles = async (): Promise<AnnouncementAttachment[]> => {
    const uploaded: AnnouncementAttachment[] = [];
    for (const file of newFiles) {
      const asset = await uploadAsset({
        file,
        folder: ASSET_FOLDER,
      }).unwrap();
      uploaded.push({
        asset_id: asset.id,
        file_name: asset.file_name ?? file.name,
        mime_type: asset.mime_type ?? file.type,
        size: asset.file_size ?? file.size,
      });
    }
    return uploaded;
  };

  const submit = async (data: AnnouncementFormValues, publish: boolean) => {
    setIsSaving(true);
    try {
      // Attachments are uploaded first — the announcement body only ever
      // carries asset ids that already exist server-side.
      const uploaded = await uploadPendingFiles();
      const body: AnnouncementCreate = {
        title: data.title,
        description: data.description,
        business_unit_ids: data.businessUnitIds,
        department_ids: data.departmentIds,
        attachments: [...existingAttachments, ...uploaded],
      };

      const saved = isEditing
        ? await updateAnnouncement({ id: editId!, body }).unwrap()
        : await createAnnouncement(body).unwrap();

      if (publish) {
        await publishAnnouncement(saved.id).unwrap();
        toast.success("Announcement published");
      } else {
        toast.success(
          isEditing ? "Announcement updated" : "Announcement saved as draft",
        );
      }

      setAttachmentsDirty(false);
      setNewFiles([]);
      onOpenChange(false);
    } catch (err) {
      toast.error(
        err,
        publish
          ? "Failed to publish announcement"
          : isEditing
            ? "Failed to update announcement"
            : "Failed to save announcement",
      );
    } finally {
      setIsSaving(false);
    }
  };

  /**
   * Publishing with both pickers empty reaches the entire organisation, so it
   * asks first. Only *both* empty is org-wide: an empty business-unit list with
   * departments selected is still a targeted announcement, and vice versa.
   *
   * Draft saves are not gated — nothing is delivered until publish, and the
   * audience can still be changed while it is a draft.
   */
  const publishOrConfirm = (data: AnnouncementFormValues) => {
    const isOrgWide =
      data.businessUnitIds.length === 0 && data.departmentIds.length === 0;
    if (isOrgWide) {
      setOrgWidePending(data);
      return;
    }
    submit(data, true);
  };

  const showLoadingState = isEditing && (isLoading || !populated);

  return (
    <>
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent
          side="right"
          className="flex flex-col p-0 gap-0 data-[side=right]:w-[1000px] data-[side=right]:sm:max-w-[1020px]"
        >
          <SheetHeader className="px-6 py-5 border-b">
            <SheetTitle>
              {isEditing ? "Edit Announcement" : "New Announcement"}
            </SheetTitle>
            <SheetDescription>
              {isEditing
                ? "Update this draft announcement before publishing it."
                : "Compose an announcement and publish it to your organisation."}
            </SheetDescription>
          </SheetHeader>

          {showLoadingState ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <form
              onSubmit={handleSubmit(publishOrConfirm)}
              className="flex flex-1 flex-col overflow-hidden"
            >
              <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
                {/* Title */}
                <div className="space-y-2">
                  <Label htmlFor="title">
                    Title <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="title"
                    placeholder="e.g., Office closed on 15 August"
                    maxLength={TITLE_MAX}
                    className={`h-9 ${errors.title ? "border-destructive focus-visible:ring-destructive" : ""}`}
                    aria-invalid={errors.title ? "true" : undefined}
                    aria-describedby={errors.title ? "title-error" : undefined}
                    {...register("title")}
                  />
                  {errors.title && (
                    <p
                      id="title-error"
                      role="alert"
                      className="flex items-center gap-1.5 text-xs text-destructive"
                    >
                      <AlertCircle className="size-3.5 shrink-0" />
                      {errors.title.message}
                    </p>
                  )}
                </div>

                {/* Targeting */}
                <div>
                  <h3 className="text-sm font-semibold text-foreground mb-4">
                    Audience
                  </h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Business Units</Label>
                      <SearchableSelect
                        multi
                        options={businessUnitOptions}
                        value={watch("businessUnitIds")}
                        onChange={(val) =>
                          setValue("businessUnitIds", val as string[], {
                            shouldDirty: true,
                            shouldValidate: true,
                          })
                        }
                        className={cn(
                          "[&_svg]:text-muted-foreground",
                          errors.businessUnitIds &&
                            "border-destructive focus:ring-destructive",
                        )}
                        placeholder={
                          businessUnitsLoading
                            ? "Loading..."
                            : businessUnitsError
                              ? "Failed to load business units"
                              : businessUnitOptions.length === 0
                                ? "No business units available"
                                : "All business units"
                        }
                        disabled={
                          businessUnitsLoading ||
                          businessUnitsError ||
                          businessUnitOptions.length === 0
                        }
                      />
                      {errors.businessUnitIds ? (
                        <p
                          role="alert"
                          className="flex items-center gap-1.5 text-xs text-destructive"
                        >
                          <AlertCircle className="size-3.5 shrink-0" />
                          {errors.businessUnitIds.message}
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          {watch("businessUnitIds").length === 0
                            ? "Every business unit, including ones added later."
                            : "Only the selected business units."}
                        </p>
                      )}
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label>Departments</Label>
                        {departmentOptions.length > 1 &&
                          selectedDepartmentIds.length > 0 && (
                            <button
                              type="button"
                              className="text-xs text-primary hover:underline"
                              // Clearing the picker IS the organisation-wide
                              // action — an empty list means every department.
                              // Ticking them all one by one looks equivalent but
                              // freezes the audience at today's departments, so
                              // "Select all" is deliberately not offered.
                              onClick={() =>
                                setValue("departmentIds", [], {
                                  shouldDirty: true,
                                  shouldValidate: true,
                                })
                              }
                            >
                              Clear all
                            </button>
                          )}
                      </div>
                      <SearchableSelect
                        multi
                        options={departmentOptions}
                        value={selectedDepartmentIds}
                        onChange={(val) =>
                          setValue("departmentIds", val as string[], {
                            shouldDirty: true,
                            shouldValidate: true,
                          })
                        }
                        className={cn(
                          "[&_svg]:text-muted-foreground",
                          errors.departmentIds &&
                            "border-destructive focus:ring-destructive",
                        )}
                        placeholder={
                          departmentsLoading
                            ? "Loading..."
                            : departmentsError
                              ? "Failed to load departments"
                              : departmentOptions.length === 0
                                ? "No departments available"
                                : "All departments"
                        }
                        disabled={
                          departmentsLoading ||
                          departmentsError ||
                          departmentOptions.length === 0
                        }
                      />
                      {errors.departmentIds ? (
                        <p
                          role="alert"
                          className="flex items-center gap-1.5 text-xs text-destructive"
                        >
                          <AlertCircle className="size-3.5 shrink-0" />
                          {errors.departmentIds.message}
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          {selectedDepartmentIds.length === 0
                            ? "Every department, including ones added later."
                            : "Only the selected departments."}
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                {/* Description */}
                <div className="space-y-2">
                  <Label htmlFor="description">
                    Description <span className="text-destructive">*</span>
                  </Label>
                  <RichTextEditor
                    multiline
                    id="description"
                    placeholder="What do you want everyone to know?"
                    maxLength={DESCRIPTION_MAX}
                    value={watch("description")}
                    onChange={(html) =>
                      setValue("description", html, {
                        shouldDirty: true,
                        shouldValidate: !!errors.description,
                      })
                    }
                    onBlur={() => trigger("description")}
                    invalid={!!errors.description}
                    disabled={isSaving}
                    minHeightClass="min-h-[200px]"
                    ariaDescribedBy={
                      errors.description ? "description-error" : undefined
                    }
                  />
                  {errors.description && (
                    <p
                      id="description-error"
                      role="alert"
                      className="flex items-center gap-1.5 text-xs text-destructive"
                    >
                      <AlertCircle className="size-3.5 shrink-0" />
                      {errors.description.message}
                    </p>
                  )}
                </div>

                {/* Attachments */}
                <div className="space-y-2">
                  <Label>Attachments</Label>

                  <AttachmentDropzone
                    value={newFiles}
                    onChange={(files) => {
                      setNewFiles(files);
                      setAttachmentsDirty(true);
                    }}
                    alreadyAttached={existingAttachments.length}
                    disabled={isSaving}
                  />

                  {existingAttachments.length === 0 && newFiles.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {/* Optional — the only field that is. */}
                    </p>
                  ) : (
                    <ul className="divide-y rounded-xl border">
                      {existingAttachments.map((att) => (
                        <li
                          key={att.asset_id}
                          className="flex items-center gap-3 px-3 py-2"
                        >
                          <Paperclip className="size-4 shrink-0 text-muted-foreground" />
                          <div className="min-w-0 flex-1">
                            <button
                              type="button"
                              onClick={() => viewExisting(att)}
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
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                            aria-label={`Remove ${att.file_name}`}
                            onClick={() => removeExisting(att.asset_id)}
                            disabled={isSaving}
                          >
                            <X className="size-4" />
                          </Button>
                        </li>
                      ))}
                      {newFiles.map((file, index) => (
                        <li
                          key={`${file.name}-${index}`}
                          className="flex items-center gap-3 px-3 py-2"
                        >
                          <Paperclip className="size-4 shrink-0 text-muted-foreground" />
                          <div className="min-w-0 flex-1">
                            <button
                              type="button"
                              onClick={() => openLocalFile(file)}
                              title={`View ${file.name}`}
                              className="block max-w-full truncate text-left text-sm text-foreground hover:text-primary hover:underline"
                            >
                              {file.name}
                            </button>
                            <p className="text-xs text-muted-foreground">
                              {formatFileSize(file.size)}
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                            aria-label={`Remove ${file.name}`}
                            onClick={() => removeNewFile(index)}
                            disabled={isSaving}
                          >
                            <X className="size-4" />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              <div className="border-t px-6 py-4 flex items-center justify-between">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleOpenChange(false)}
                  disabled={isSaving}
                >
                  Cancel
                </Button>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleSubmit((data) => submit(data, false))}
                    disabled={isSaving || (isEditing && !dirty)}
                  >
                    {isSaving && <Loader2 className="animate-spin" />}
                    Save Draft
                  </Button>
                  <Button
                    type="submit"
                    className="bg-[#EAE6FF] text-foreground hover:bg-[#EAE6FF]/90"
                    disabled={isSaving}
                  >
                    {isSaving && <Loader2 className="animate-spin" />}
                    Publish
                  </Button>
                </div>
              </div>
            </form>
          )}
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="Unsaved changes"
        description="You have unsaved changes. Are you sure you want to leave without saving?"
        cancelLabel="Stay"
        confirmLabel="Leave without saving"
        onConfirm={() => {
          setDiscardOpen(false);
          onOpenChange(false);
        }}
      />

      <ConfirmDialog
        open={orgWidePending !== null}
        onOpenChange={(next) => {
          if (!next) setOrgWidePending(null);
        }}
        title="Publish to the whole organisation?"
        description="No business units or departments are selected, so this announcement will reach every employee in the organisation — including anyone in units or departments added later."
        cancelLabel="Go back"
        confirmLabel="Publish to everyone"
        onConfirm={() => {
          const data = orgWidePending;
          setOrgWidePending(null);
          if (data) submit(data, true);
        }}
      />
    </>
  );
};
