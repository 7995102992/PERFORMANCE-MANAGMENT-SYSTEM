import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { FormSheet } from '@/components/shared/FormSheet'
import { SearchableSelect } from '@/components/shared/SearchableSelect'
import { useConfirm } from '@/providers/confirm-dialog-provider'
import { useUnsavedGuard } from '@/hooks/use-unsaved-guard'
import { useAppSelector } from '@/store'
import { useBusinessUnits } from '@/hooks/queries/use-business-unit'
import { useDepartmentsByBUs } from '@/hooks/queries/use-departments'
import { useAutoSelectSingleOption } from '@/hooks/use-auto-select-single'
import type { DocumentFolder } from '@/modules/org-setup/types/org-documents'

// ─── Worker types (static — not from API) ────────────────────────────────────

const WORKER_TYPE_OPTIONS = [
  { label: 'Full-Time', value: 'full-time' },
  { label: 'Contract', value: 'contract' },
  { label: 'Internship', value: 'internship' },
]

// ─── Props ────────────────────────────────────────────────────────────────────

interface FolderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (folder: DocumentFolder) => void
  editingFolder?: DocumentFolder | null
  existingFolderNames?: string[]
}

// ─── Component ────────────────────────────────────────────────────────────────

export function FolderDialog({ open, onOpenChange, onSave, editingFolder = null, existingFolderNames = [] }: FolderDialogProps) {
  const confirm = useConfirm()
  const savedOrg = useAppSelector((s) => s.organisation.savedOrganisation)
  const { data: remoteBUs = [] } = useBusinessUnits(savedOrg?.id, { is_active: true })

  const buOptions = remoteBUs.map((bu) => ({ label: bu.business_unit_name, value: bu.id }))
  const buNameMap = React.useMemo(() => {
    const map: Record<string, string> = {}
    for (const bu of remoteBUs) map[bu.id] = bu.business_unit_name
    return map
  }, [remoteBUs])

  // Departments filtered by selected BUs — shows "BU Name - Dept Name"
  const [businessUnits, setBusinessUnits] = React.useState<string[]>([])
  const { data: filteredDepts = [] } = useDepartmentsByBUs(savedOrg?.id, businessUnits)

  const deptOptions = React.useMemo(() =>
    filteredDepts.map((d) => {
      const buNames = (d.businessUnits ?? [])
        .map((buId: string) => buNameMap[buId])
        .filter(Boolean)
        .join(', ')
      return { label: d.departmentName, value: d.id, description: buNames || undefined }
    }),
    [filteredDepts, buNameMap],
  )

  const [name, setName] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [customAccess, setCustomAccess] = React.useState(false)
  const [departments, setDepartments] = React.useState<string[]>([])
  const [workerTypes, setWorkerTypes] = React.useState<string[]>([])
  const [isActive, setIsActive] = React.useState(true)
  const [submitted, setSubmitted] = React.useState(false)

  // Single-BU org → lock the access BU picker; auto-fill BU/Dept when only one
  // exists. Only while custom access is on (otherwise access scope is unused).
  const singleBuMode = !savedOrg?.is_multiple_business_units
  useAutoSelectSingleOption({
    value: businessUnits,
    options: buOptions,
    onSelect: (v) => setBusinessUnits([v]),
    enabled: customAccess,
  })
  useAutoSelectSingleOption({
    value: departments,
    options: deptOptions,
    onSelect: (v) => setDepartments([v]),
    enabled: customAccess,
  })
  const [isSaving, setIsSaving] = React.useState(false)

  const isDirty = !!name.trim() || !!description.trim() || customAccess || businessUnits.length > 0
  const guardedOpenChange = useUnsavedGuard(isDirty, onOpenChange)

  React.useEffect(() => {
    if (!open) return
    if (editingFolder) {
      setName(editingFolder.name)
      setDescription(editingFolder.description)
      setCustomAccess(editingFolder.customAccess)
      setBusinessUnits(editingFolder.access.businessUnits)
      setDepartments(editingFolder.access.departments)
      setWorkerTypes(editingFolder.access.workerTypes)
      setIsActive(editingFolder.isActive)
    } else {
      setName('')
      setDescription('')
      setCustomAccess(false)
      setBusinessUnits([])
      setDepartments([])
      setWorkerTypes([])
      setIsActive(true)
    }
    setSubmitted(false)
    setIsSaving(false)
  }, [open, editingFolder])

  const trimmedName = name.trim()
  const isDuplicateName = trimmedName && existingFolderNames.some(
    (n) => n.toLowerCase() === trimmedName.toLowerCase() && (!editingFolder || editingFolder.name.toLowerCase() !== trimmedName.toLowerCase())
  )
  const nameError = submitted
    ? !trimmedName ? 'Folder name is required'
    : trimmedName.length > 100 ? 'Must be 100 characters or less'
    : isDuplicateName ? 'A folder with this name already exists'
    : undefined
    : undefined
  const buError = submitted && customAccess && businessUnits.length === 0 ? 'Select at least one business unit' : undefined
  const deptError = submitted && customAccess && departments.length === 0 ? 'Select at least one department' : undefined
  const wtError = submitted && customAccess && workerTypes.length === 0 ? 'Select at least one worker type' : undefined

  const isValid = !!trimmedName && trimmedName.length <= 100 && !isDuplicateName
    && (!customAccess || (businessUnits.length > 0 && departments.length > 0 && workerTypes.length > 0))

  async function handleSave() {
    setSubmitted(true)
    if (!isValid) return
    setIsSaving(true)
    try {
      await onSave({
        id: editingFolder?.id ?? `folder_${Date.now()}`,
        name: name.trim(),
        description: description.trim(),
        customAccess,
        access: { businessUnits, departments, workerTypes },
        isActive,
        updatedAt: new Date().toISOString(),
      })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <FormSheet
      open={open}
      onOpenChange={guardedOpenChange}
      title={editingFolder ? 'Edit Folder' : 'New Document Folder'}
      width={520}
      submitting={isSaving}
      submitLabel={isSaving ? 'Saving...' : editingFolder ? 'Save Changes' : 'Create Folder'}
      onSubmit={handleSave}
    >
      <div className="space-y-5">

        {/* Name */}
        <div className="space-y-3">
          <Label>Folder Name <span className="text-destructive">*</span></Label>
          <Input
            placeholder="e.g. Company Policies"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
          />
          {nameError && <p className="text-sm text-destructive">{nameError}</p>}
        </div>

        {/* Description */}
        <div className="space-y-3">
          <Label>Description <span className="text-muted-foreground font-normal text-xs">(optional)</span></Label>
          <Textarea
            placeholder="Briefly describe what this folder contains..."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="resize-none"
          />
        </div>

        {/* Access toggle */}
        <div className="rounded-xl border">
          <div className="flex items-center justify-between p-4">
            <div>
              <p className="text-sm font-medium">Custom Access</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {customAccess
                  ? 'Only selected groups can access this folder'
                  : 'All employees can access this folder'}
              </p>
            </div>
            <Switch checked={customAccess} onCheckedChange={setCustomAccess} />
          </div>

          {customAccess && (
            <div className="border-t p-4 space-y-4 bg-muted/30">
              <div className="space-y-3">
                <Label>Business Units <span className="text-destructive">*</span></Label>
                <SearchableSelect
                  multi
                  options={buOptions}
                  value={businessUnits}
                  onChange={(v) => {
                    setBusinessUnits(v)
                    setDepartments([]) // clear depts when BUs change
                  }}
                  placeholder="Select business units..."
                  disabled={singleBuMode}
                />
                {buError && <p className="text-sm text-destructive">{buError}</p>}
              </div>

              <div className="space-y-3">
                <Label>Departments <span className="text-destructive">*</span></Label>
                <SearchableSelect
                  multi
                  options={deptOptions}
                  value={departments}
                  onChange={(v) => setDepartments(v)}
                  placeholder={businessUnits.length === 0 ? "Select business units first..." : "Select departments..."}
                  disabled={businessUnits.length === 0}
                />
                {deptError && <p className="text-sm text-destructive">{deptError}</p>}
              </div>

              <div className="space-y-3">
                <Label>Worker Types <span className="text-destructive">*</span></Label>
                <SearchableSelect
                  multi
                  options={WORKER_TYPE_OPTIONS}
                  value={workerTypes}
                  onChange={(v) => setWorkerTypes(v)}
                  placeholder="Select worker types..."
                />
                {wtError && <p className="text-sm text-destructive">{wtError}</p>}
              </div>
            </div>
          )}
        </div>

        {/* Status toggle — edit mode only */}
        {editingFolder && (
          <div className="rounded-xl border">
            <div className="flex items-center justify-between p-4">
              <div>
                <p className="text-sm font-medium">Status</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {isActive
                    ? 'Folder is active and visible to employees'
                    : 'Folder is inactive and hidden from employees'}
                </p>
              </div>
              <Switch
                checked={isActive}
                onCheckedChange={(checked) => {
                  if (!checked && editingFolder.isActive) {
                    confirm({
                      title: 'Deactivate Folder',
                      description: `All documents in "${editingFolder.name}" will be permanently deleted. This action cannot be undone.`,
                      confirmText: 'Deactivate',
                      variant: 'destructive',
                      onConfirm: async () => setIsActive(false),
                    })
                  } else {
                    setIsActive(checked)
                  }
                }}
              />
            </div>
          </div>
        )}

      </div>
    </FormSheet>
  )
}
