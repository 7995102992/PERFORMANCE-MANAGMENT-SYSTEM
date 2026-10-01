import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Clock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MultiFileUploader } from "@/components/shared/MultiFileUploader";
import { SearchableSelect } from "@/components/shared/SearchableSelect";
import { usePagedSelect } from "./usePagedSelect";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { toast } from "@/lib/toast";
import {
  useGetCategoriesQuery,
  useGetRequestTypesQuery,
  useRaiseRequestMutation,
} from "@/store/api/srmApi";
import type {
  Category,
  RaiseRequestPayload,
  RequestTypeListItem,
} from "@/types/service-request";

const PRIORITIES = ["low", "medium", "high", "urgent"] as const;

const TITLE_MIN = 5;
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 5000;
const MAX_FILE_MB = 10;
const MAX_FILES = 10;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful submit so the parent can refresh its list. */
  onCreated?: () => void;
  /** Pre-select the Category when opened (e.g. from an email deep link). */
  initialCategoryId?: string;
  /** Pre-select the Subtype / request type when opened. */
  initialRequestTypeId?: string;
}

export const RequestForm = ({
  open,
  onOpenChange,
  onCreated,
  initialCategoryId,
  initialRequestTypeId,
}: Props) => {
  const [title, setTitle] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [requestTypeId, setRequestTypeId] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<string>("low");
  const [files, setFiles] = useState<File[]>([]);
  // Errors only show after the user clicks Save once.
  const [attempted, setAttempted] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);

  // Both pickers page + search server-side. /categories and /request-types cap
  // a page at 25 rows, so without this an org with more than that showed a
  // silently truncated list — the user simply couldn't pick what wasn't there.
  //
  // `has_active_workflow` filters server-side to categories / request types
  // that have a live workflow. Plain employees lack manage_workflows so we
  // can't read /workflows directly — the backend joins on Workflow internally.
  //
  // The drawer is mounted (closed) by the Topbar on every page, so both queries
  // are skipped until it opens or they'd fetch on every page load.
  const categoryPicker = usePagedSelect<Category>({
    useQuery: useGetCategoriesQuery,
    args: { status: "active", has_active_workflow: true },
    toOption: (c) => ({ label: c.name, value: c.id }),
    skip: !open,
  });

  const requestTypePicker = usePagedSelect<RequestTypeListItem>({
    useQuery: useGetRequestTypesQuery,
    args: { category_id: categoryId, has_active_workflow: true },
    toOption: (rt) => ({
      label: rt.request_type_name,
      value: rt.request_type_id,
    }),
    // Switching category is a different result set — drop the loaded pages.
    resetKey: categoryId,
    skip: !open || !categoryId,
  });
  const requestTypesData = requestTypePicker.data;

  // Backend returns one row per (RT × SLA-rule); each row carries the
  // priority of THAT sla rule. Keep the raw rows around so we can derive
  // which priorities are available per RT.
  const requestTypeRows = requestTypesData?.items ?? [];
  const requestTypes = Array.from(
    new Map(requestTypeRows.map((rt) => [rt.request_type_id, rt])).values(),
  );
  const selectedRequestType = requestTypes.find(
    (rt) => rt.request_type_id === requestTypeId,
  );
  // Priorities the selected RT actually has SLA rules for. Without this,
  // picking a priority with no SLA → backend 404 NO_SLA_AVAILABLE.
  const availablePriorities = useMemo(() => {
    if (!requestTypeId) return [] as string[];
    const set = new Set<string>();
    for (const row of requestTypeRows) {
      if (row.request_type_id === requestTypeId) set.add(row.priority);
    }
    // Order by our canonical PRIORITIES list, not insertion order.
    return PRIORITIES.filter((p) => set.has(p));
  }, [requestTypeRows, requestTypeId]);

  // Auto-snap priority to a valid one whenever the selected RT changes (or
  // its available priorities change). Picks the first available in
  // low→urgent order so the form stays in a submittable state.
  useEffect(() => {
    if (availablePriorities.length === 0) return;
    if (!availablePriorities.includes(priority)) {
      setPriority(availablePriorities[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availablePriorities.join("|")]);

  const [raiseRequest, { isLoading }] = useRaiseRequestMutation();

  // Reset everything when the slider closes so it opens fresh next time.
  // On open, seed Category / Subtype from deep-link params (email links) so
  // the form comes up pre-populated. Empty params leave the fields blank.
  useEffect(() => {
    if (open) {
      if (initialCategoryId) setCategoryId(initialCategoryId);
      if (initialRequestTypeId) setRequestTypeId(initialRequestTypeId);
    } else {
      setTitle("");
      setCategoryId("");
      setRequestTypeId("");
      setDescription("");
      setPriority("low");
      setFiles([]);
      setAttempted(false);
      setIsDirty(false);
      // Drop the accumulated picker pages so they reopen on page 1 rather than
      // showing a stale, partially-paged list.
      categoryPicker.reset();
      requestTypePicker.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open && isDirty) {
        setDiscardOpen(true);
      } else {
        onOpenChange(open);
      }
    },
    [isDirty, onOpenChange],
  );

  // Field-level validation — reactive, surfaced once `attempted` is true.
  const errors = useMemo(() => {
    const e: {
      title?: string;
      categoryId?: string;
      requestTypeId?: string;
      description?: string;
    } = {};
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      e.title = "Title is required";
    } else if (trimmedTitle.length < TITLE_MIN) {
      e.title = `Title must be at least ${TITLE_MIN} characters`;
    } else if (trimmedTitle.length > TITLE_MAX) {
      e.title = `Title must be ${TITLE_MAX} characters or fewer`;
    }
    if (!categoryId) e.categoryId = "Category is required";
    if (!requestTypeId) e.requestTypeId = "Subtype is required";
    if (!description.trim()) {
      e.description = "Description is required";
    } else if (description.length > DESCRIPTION_MAX) {
      e.description = `Description must be ${DESCRIPTION_MAX} characters or fewer`;
    }
    return e;
  }, [title, categoryId, requestTypeId, description]);
  const hasErrors = Object.keys(errors).length > 0;

  const handleSubmit = async () => {
    if (hasErrors) {
      setAttempted(true);
      toast.error("Please fix the highlighted fields before saving");
      return;
    }
    const payload: RaiseRequestPayload = {
      category_id: categoryId,
      request_type_id: requestTypeId,
      title: title.trim(),
      description: description.trim(),
      priority: priority as RaiseRequestPayload["priority"],
    };
    try {
      await raiseRequest({
        payload,
        files: files.length ? files : undefined,
      }).unwrap();
      toast.success(
        "Ticket submitted",
        "Your service ticket has been created",
      );
      onCreated?.();
      onOpenChange(false);
    } catch (err) {
      toast.error(err, "Failed to submit ticket");
    }
  };

  return (
    <>
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent className="w-[680px] sm:max-w-[720px] flex flex-col p-0 gap-0">
          <SheetHeader className="px-6 py-4 border-b">
            <SheetTitle>Raise New Ticket</SheetTitle>
            <SheetDescription>
              Submit a new service ticket to your IT / HR / Engineering team.
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto">
            {/* Section: Create New Ticket */}
            <div className="px-6 py-5 space-y-5">
              <h2 className="text-sm font-semibold text-foreground">
                Create New Ticket
              </h2>

              {/* Category + Subtype, 2 columns */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>
                    Category <span className="text-destructive">*</span>
                  </Label>
                  <div
                    className={
                      attempted && errors.categoryId
                        ? "rounded-md ring-1 ring-destructive"
                        : ""
                    }
                    aria-invalid={
                      attempted && errors.categoryId ? "true" : undefined
                    }
                  >
                    <SearchableSelect
                      {...categoryPicker.selectProps}
                      value={categoryId}
                      onChange={(v) => {
                        setCategoryId(v as string);
                        setRequestTypeId("");
                        setIsDirty(true);
                      }}
                      emptyMessage="No categories with active workflows"
                      placeholder={
                        categoryPicker.isEmpty
                          ? "No categories with active workflows"
                          : "Select Category"
                      }
                      disabled={categoryPicker.isEmpty}
                    />
                  </div>
                  {attempted && errors.categoryId && (
                    <p
                      role="alert"
                      className="flex items-center gap-1.5 text-sm font-medium text-destructive"
                    >
                      <AlertCircle className="size-3.5 shrink-0" />
                      {errors.categoryId}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label>
                    Subtype <span className="text-destructive">*</span>
                  </Label>
                  <div
                    className={
                      attempted && errors.requestTypeId
                        ? "rounded-md ring-1 ring-destructive"
                        : ""
                    }
                    aria-invalid={
                      attempted && errors.requestTypeId ? "true" : undefined
                    }
                  >
                    <SearchableSelect
                      {...requestTypePicker.selectProps}
                      value={requestTypeId}
                      onChange={(v) => {
                        setRequestTypeId(v as string);
                        setIsDirty(true);
                      }}
                      emptyMessage="No subtypes with active workflows"
                      placeholder={
                        !categoryId
                          ? "Pick a category first"
                          : requestTypePicker.isEmpty
                            ? "No subtypes with active workflows"
                            : "Select Subtype"
                      }
                      disabled={!categoryId}
                    />
                  </div>
                  {attempted && errors.requestTypeId && (
                    <p
                      role="alert"
                      className="flex items-center gap-1.5 text-sm font-medium text-destructive"
                    >
                      <AlertCircle className="size-3.5 shrink-0" />
                      {errors.requestTypeId}
                    </p>
                  )}
                </div>
              </div>

              {/* Title, full width */}
              <div className="space-y-2">
                <Label htmlFor="req-title">
                  Title <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="req-title"
                  placeholder="Briefly describe what you need"
                  value={title}
                  maxLength={TITLE_MAX}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setIsDirty(true);
                  }}
                  className={
                    attempted && errors.title
                      ? "border-destructive focus-visible:ring-destructive"
                      : ""
                  }
                  aria-invalid={attempted && errors.title ? "true" : undefined}
                />
                <div className="flex items-start justify-between gap-2">
                  {attempted && errors.title ? (
                    <p
                      role="alert"
                      className="flex items-center gap-1.5 text-sm font-medium text-destructive"
                    >
                      <AlertCircle className="size-3.5 shrink-0" />
                      {errors.title}
                    </p>
                  ) : (
                    <span />
                  )}
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {title.length}/{TITLE_MAX}
                  </span>
                </div>
              </div>

              {/* Description */}
              <div className="space-y-2">
                <Label htmlFor="req-description">
                  Ticket Description{" "}
                  <span className="text-destructive">*</span>
                </Label>
                <Textarea
                  id="req-description"
                  placeholder="Give as much context as you can — what you need, why, any details that help the team act faster"
                  value={description}
                  onChange={(e) => {
                    setDescription(e.target.value);
                    setIsDirty(true);
                  }}
                  rows={4}
                  maxLength={DESCRIPTION_MAX}
                  className={
                    attempted && errors.description
                      ? "border-destructive focus-visible:ring-destructive"
                      : ""
                  }
                  aria-invalid={
                    attempted && errors.description ? "true" : undefined
                  }
                />
                <div className="flex items-start justify-between gap-2">
                  {attempted && errors.description ? (
                    <p
                      role="alert"
                      className="flex items-center gap-1.5 text-sm font-medium text-destructive"
                    >
                      <AlertCircle className="size-3.5 shrink-0" />
                      {errors.description}
                    </p>
                  ) : (
                    <span />
                  )}
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {description.length}/{DESCRIPTION_MAX}
                  </span>
                </div>
              </div>

              {/* Priority */}
              <div className="space-y-2">
                <Label>Priority Level</Label>
                <div className="flex items-center gap-6 flex-wrap">
                  {PRIORITIES.map((p) => (
                    <label
                      key={p}
                      className="flex items-center gap-2 cursor-pointer"
                    >
                      <input
                        type="radio"
                        name="priority"
                        checked={priority === p}
                        onChange={() => setPriority(p)}
                        className="accent-primary cursor-pointer"
                      />
                      <span className="text-sm text-foreground capitalize">
                        {p}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {/* SLA hint — only after a request type is picked */}
              {selectedRequestType && (
                <div className="flex items-start gap-3 rounded-xl border bg-muted/30 px-4 py-3">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 mt-0.5">
                    <Clock className="size-4 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">
                      Service Level Agreement (SLA)
                    </p>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      Based on the selected category and priority, your ticket
                      will be processed within the configured SLA window for{" "}
                      <span className="font-medium text-foreground">
                        {selectedRequestType.request_type_name}
                      </span>
                      .
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div className="border-t border-border" />

            {/* Section: Attachments */}
            <div className="px-6 py-5 space-y-3">
              <h2 className="text-sm font-semibold text-foreground">
                Attachments
              </h2>
              <MultiFileUploader
                value={files}
                onChange={setFiles}
                maxSizeMB={MAX_FILE_MB}
                maxFiles={MAX_FILES}
              />
            </div>
          </div>

          {/* Footer */}
          <div className="border-t border-border px-6 py-4 flex items-center justify-end gap-2">
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="soft" disabled={isLoading} onClick={handleSubmit}>
              {isLoading && <Loader2 className="animate-spin" />}
              Save
            </Button>
          </div>
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
    </>
  );
};
