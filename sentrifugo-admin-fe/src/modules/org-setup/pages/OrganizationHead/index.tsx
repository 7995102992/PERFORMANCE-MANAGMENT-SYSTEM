import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { SearchableSelect } from '@/components/shared/SearchableSelect'
import { useAppSelector } from '@/store'
import { useOrganisation } from '@/hooks/queries/use-organisation'
import { useBusinessUnits } from '@/hooks/queries/use-business-unit'
import { useDepartmentsByBUs } from '@/hooks/queries/use-departments'
import { useEmployees } from '@/hooks/queries/use-employees'
import { useAutoSelectSingleOption } from '@/hooks/use-auto-select-single'
import { organisationService } from '@/api/org-setup/organisation'
import { businessUnitService } from '@/api/org-setup/business-unit'
import { departmentsService } from '@/api/org-setup/departments'
import { useConfirm } from '@/providers/confirm-dialog-provider'
import { useQueryClient } from '@tanstack/react-query'
import { UserCog } from 'lucide-react'
import { toast } from '@/lib/toast'
import { useNavigationGuard } from '@/hooks/use-navigation-guard'

export function OrganizationHead() {
    const confirm = useConfirm()
    const queryClient = useQueryClient()
    const savedOrg = useAppSelector((s) => s.organisation.savedOrganisation)
    const orgId = savedOrg?.id
    const { data: freshOrg } = useOrganisation(orgId ?? null)

    const { data: remoteBUs = [] } = useBusinessUnits(orgId, { is_active: true })
    const { data: remoteEmps = [] } = useEmployees(orgId, { limit: 1000 })

    const [selectedBuId, setSelectedBuId] = useState('')
    const [selectedDeptId, setSelectedDeptId] = useState('')

    const { data: filteredDepts = [] } = useDepartmentsByBUs(
        orgId,
        selectedBuId ? [selectedBuId] : undefined
    )

    const empOptions = remoteEmps.map((e) => ({
        label: `${e.firstName} ${e.lastName} (${e.empCode})`,
        value: e.userId ?? '',
    }))

    // ── Tracked state: original (from API) + current (edited) ────────────────

    const [orgHead, setOrgHead] = useState('')
    const [orgHeadOriginal, setOrgHeadOriginal] = useState('')

    const [buHead, setBuHead] = useState('')
    const [buHeadOriginal, setBuHeadOriginal] = useState('')

    const [deptHead, setDeptHead] = useState('')
    const [deptHeadOriginal, setDeptHeadOriginal] = useState('')

    // Track all changes made during session: { entityType-entityId: newValue }
    const [pendingChanges, setPendingChanges] = useState<
        Record<string, { type: 'org' | 'bu' | 'dept'; id: string; name: string; value: string | null }>
    >({})

    const [saving, setSaving] = useState<'org' | 'bu' | 'dept' | 'all' | null>(null)

    // Pre-fill org head once from fresh API data
    const orgPrefilled = useRef(false)
    useEffect(() => {
        if (orgPrefilled.current || !freshOrg) return
        orgPrefilled.current = true
        const val = freshOrg.head_user_id ?? ''
        setOrgHead(val)
        setOrgHeadOriginal(val)
    }, [freshOrg])

    // Resolve selected entities
    const selectedBu = remoteBUs.find((bu) => bu.id === selectedBuId)
    const selectedDept = filteredDepts.find((d) => d.id === selectedDeptId)

    function handleBuSelect(buId: string) {
        setSelectedBuId(buId)
        setSelectedDeptId('')
        setDeptHead('')
        setDeptHeadOriginal('')
        const bu = remoteBUs.find((b) => b.id === buId)
        const current = bu?.head_user_id ?? ''
        setBuHead(pendingChanges[`bu-${buId}`]?.value ?? current)
        setBuHeadOriginal(current)
    }

    function handleDeptSelect(deptId: string) {
        setSelectedDeptId(deptId)
        const dept = filteredDepts.find((d) => d.id === deptId)
        const current = dept?.departmentHead ?? ''
        setDeptHead(pendingChanges[`dept-${deptId}`]?.value ?? current)
        setDeptHeadOriginal(current)
    }

    // ── Change tracking ──────────────────────────────────────────────────────

    function handleOrgHeadChange(val: string) {
        setOrgHead(val)
        if (val !== orgHeadOriginal) {
            setPendingChanges((prev) => ({
                ...prev,
                'org': { type: 'org', id: orgId!, name: freshOrg?.legal_name ?? savedOrg?.legal_name ?? 'Organisation', value: val || null },
            }))
        } else {
            setPendingChanges((prev) => { const next = { ...prev }; delete next['org']; return next })
        }
    }

    function handleBuHeadChange(val: string) {
        setBuHead(val)
        const key = `bu-${selectedBuId}`
        if (val !== buHeadOriginal) {
            setPendingChanges((prev) => ({
                ...prev,
                [key]: { type: 'bu', id: selectedBuId, name: selectedBu?.business_unit_name ?? '', value: val || null },
            }))
        } else {
            setPendingChanges((prev) => { const next = { ...prev }; delete next[key]; return next })
        }
    }

    function handleDeptHeadChange(val: string) {
        setDeptHead(val)
        const key = `dept-${selectedDeptId}`
        if (val !== deptHeadOriginal) {
            setPendingChanges((prev) => ({
                ...prev,
                [key]: { type: 'dept', id: selectedDeptId, name: selectedDept?.departmentName ?? '', value: val || null },
            }))
        } else {
            setPendingChanges((prev) => { const next = { ...prev }; delete next[key]; return next })
        }
    }

    const changeCount = Object.keys(pendingChanges).length
    useNavigationGuard(changeCount > 0)

    // ── Individual save ──────────────────────────────────────────────────────

    async function saveOrgHead() {
        if (!orgId) return
        confirm({
            title: 'Update Organisation Head',
            description: 'Update the head for the organisation?',
            confirmText: 'Update',
            onConfirm: async () => {
                setSaving('org')
                try {
                    await organisationService.update(orgId, { head_user_id: orgHead || null })
                    setOrgHeadOriginal(orgHead)
                    setPendingChanges((prev) => { const next = { ...prev }; delete next['org']; return next })
                    queryClient.invalidateQueries({ queryKey: ['organisation'] })
                    toast.success('Organisation head updated successfully')
                } catch (err) {
                    toast.error(err, 'Failed to update organisation head')
                } finally {
                    setSaving(null)
                }
            },
        })
    }

    async function saveBuHead() {
        if (!selectedBuId) return
        confirm({
            title: 'Update Business Unit Head',
            description: `Update the head for "${selectedBu?.business_unit_name}"?`,
            confirmText: 'Update',
            onConfirm: async () => {
                setSaving('bu')
                try {
                    await businessUnitService.update(selectedBuId, { head_user_id: buHead || null })
                    setBuHeadOriginal(buHead)
                    const key = `bu-${selectedBuId}`
                    setPendingChanges((prev) => { const next = { ...prev }; delete next[key]; return next })
                    queryClient.invalidateQueries({ queryKey: ['business-units'] })
                    toast.success('Business unit head updated successfully')
                } catch (err) {
                    toast.error(err, 'Failed to update business unit head')
                } finally {
                    setSaving(null)
                }
            },
        })
    }

    async function saveDeptHead() {
        if (!selectedDeptId) return
        confirm({
            title: 'Update Department Head',
            description: `Update the head for "${selectedDept?.departmentName}"?`,
            confirmText: 'Update',
            onConfirm: async () => {
                setSaving('dept')
                try {
                    await departmentsService.update(selectedDeptId, { departmentHead: deptHead || null })
                    setDeptHeadOriginal(deptHead)
                    const key = `dept-${selectedDeptId}`
                    setPendingChanges((prev) => { const next = { ...prev }; delete next[key]; return next })
                    queryClient.invalidateQueries({ queryKey: ['departments'] })
                    toast.success('Department head updated successfully')
                } catch (err) {
                    toast.error(err, 'Failed to update department head')
                } finally {
                    setSaving(null)
                }
            },
        })
    }

    // ── Bulk save all pending changes ────────────────────────────────────────

    async function saveAll() {
        if (changeCount === 0) return
        const changes = Object.values(pendingChanges)
        const summary = changes.map((c) => `${c.name} (${c.type.toUpperCase()})`).join(', ')

        confirm({
            title: 'Save All Changes',
            description: `Update heads for: ${summary}?`,
            confirmText: `Save ${changeCount} ${changeCount === 1 ? 'change' : 'changes'}`,
            onConfirm: async () => {
                setSaving('all')
                try {
                    const promises: Promise<unknown>[] = []
                    for (const change of changes) {
                        if (change.type === 'org') {
                            promises.push(organisationService.update(change.id, { head_user_id: change.value }))
                        } else if (change.type === 'bu') {
                            promises.push(businessUnitService.update(change.id, { head_user_id: change.value }))
                        } else if (change.type === 'dept') {
                            promises.push(departmentsService.update(change.id, { departmentHead: change.value }))
                        }
                    }
                    await Promise.all(promises)

                    // Reset tracking
                    setOrgHeadOriginal(orgHead)
                    if (selectedBuId) setBuHeadOriginal(buHead)
                    if (selectedDeptId) setDeptHeadOriginal(deptHead)
                    setPendingChanges({})

                    queryClient.invalidateQueries({ queryKey: ['organisation'] })
                    queryClient.invalidateQueries({ queryKey: ['business-units'] })
                    queryClient.invalidateQueries({ queryKey: ['departments'] })
                    toast.success(`${changeCount} ${changeCount === 1 ? 'head' : 'heads'} updated successfully`)
                } catch (err) {
                    toast.error(err, 'Failed to save changes')
                } finally {
                    setSaving(null)
                }
            },
        })
    }

    const buOptions = remoteBUs.map((bu) => ({ label: bu.business_unit_name, value: bu.id }))
    const deptOptions = filteredDepts.map((d) => ({ label: d.departmentName, value: d.id }))

    // Single-BU org → lock the BU pickers; auto-fill BU/Dept when only one exists.
    const singleBuMode = !savedOrg?.is_multiple_business_units
    useAutoSelectSingleOption({ value: selectedBuId, options: buOptions, onSelect: handleBuSelect })
    useAutoSelectSingleOption({ value: selectedDeptId, options: deptOptions, onSelect: handleDeptSelect })

    const orgChanged = orgHead !== orgHeadOriginal
    const buChanged = selectedBuId && buHead !== buHeadOriginal
    const deptChanged = selectedDeptId && deptHead !== deptHeadOriginal
    const orgName = freshOrg?.legal_name ?? savedOrg?.legal_name ?? 'Organisation'
    const employeeLabel = (id: string) => empOptions.find((employee) => employee.value === id)?.label ?? 'Not assigned'

    return (
        <div className="space-y-6 p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="flex items-center">
                    <div>
                        <h1 className="text-xl">Assign Heads</h1>
                        <p className="text-sm text-muted-foreground">
                            Assign accountable leaders across your organisation structure.
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    {changeCount > 0 && (
                        <Badge variant="outline" className="border-warning/40 bg-warning/10 text-warning">
                            {changeCount} unsaved {changeCount === 1 ? 'change' : 'changes'}
                        </Badge>
                    )}
                    <Button variant="soft" onClick={saveAll} disabled={changeCount === 0 || saving !== null}>
                        {saving === 'all' ? 'Saving...' : 'Save All'}
                    </Button>
                </div>
            </div>

            {/* ── Organisation Head ────────────────────────────────────── */}
            <Card>
                <CardHeader className="pb-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="flex items-start gap-3">
                            <div className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-icon-bg text-icon">
                                <UserCog className="size-4" />
                            </div>
                            <div>
                                <CardTitle className="text-base">Organisation Head</CardTitle>
                                <CardDescription>{orgName}</CardDescription>
                            </div>
                        </div>
                        <Badge variant="secondary" className="w-fit">
                            Current: {employeeLabel(orgHeadOriginal)}
                        </Badge>
                    </div>
                </CardHeader>
                <CardContent>
                    <div className="max-w-sm space-y-3">
                        <Label>Assigned Head</Label>
                        <SearchableSelect
                            options={empOptions}
                            value={orgHead}
                            onChange={handleOrgHeadChange}
                            placeholder="Select employee"
                        />
                    </div>
                    {/* <Button variant="soft" className='mt-3' onClick={saveOrgHead} disabled={!orgChanged || saving !== null}>
                        <Save className="mr-0.5 h-3.5 w-3.5" />
                        {saving === 'org' ? 'Saving...' : 'Save'}
                    </Button> */}
                </CardContent>
            </Card>

            {/* ── Business Unit Head ───────────────────────────────────── */}
            <div className="grid gap-6 xl:grid-cols-2">
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="text-base">Business Unit Head</CardTitle>
                    <CardDescription>Select a business unit to view or change its head.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="max-w-sm space-y-3">
                        <Label>Business Unit</Label>
                        <SearchableSelect
                            options={buOptions}
                            value={selectedBuId}
                            onChange={handleBuSelect}
                            placeholder="Select business unit"
                            disabled={singleBuMode}
                        />
                    </div>
                    {selectedBuId && (
                        <div className="pt-3 border-t">
                            <div className="max-w-sm space-y-3">
                                <Label>Head for {selectedBu?.business_unit_name}</Label>
                                <SearchableSelect
                                    options={empOptions}
                                    value={buHead}
                                    onChange={handleBuHeadChange}
                                    placeholder="Select employee"
                                />
                                {selectedBu?.head_employee_name?.trim() && (
                                    <p className="text-xs text-muted-foreground">
                                        Current: {selectedBu.head_employee_name.trim()}
                                    </p>
                                )}
                            </div>
                            {/* <Button size="sm" className='mt-3' variant="soft" onClick={saveBuHead} disabled={!buChanged || saving !== null}>
                                <Save className="mr-0.5 h-3.5 w-3.5" />
                                {saving === 'bu' ? 'Saving...' : 'Save'}
                            </Button> */}
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* ── Department Head ──────────────────────────────────────── */}
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="text-base">Department Head</CardTitle>
                    <CardDescription>Select a business unit, then a department to view or change its head.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-3">
                            <Label>Business Unit</Label>
                            <SearchableSelect
                                options={buOptions}
                                value={selectedBuId}
                                onChange={handleBuSelect}
                                placeholder="Select business unit"
                                disabled={singleBuMode}
                            />
                        </div>
                        <div className="space-y-3">
                            <Label>Department</Label>
                            <SearchableSelect
                                options={deptOptions}
                                value={selectedDeptId}
                                onChange={handleDeptSelect}
                                placeholder={selectedBuId ? 'Select department' : 'Select a BU first'}
                                disabled={!selectedBuId}
                            />
                        </div>
                    </div>
                    {selectedDeptId && (
                        <div className="pt-3 border-t">
                            <div className="max-w-sm space-y-3">
                                <Label>Head for {selectedDept?.departmentName}</Label>
                                <SearchableSelect
                                    options={empOptions}
                                    value={deptHead}
                                    onChange={handleDeptHeadChange}
                                    placeholder="Select employee"
                                />
                                {selectedDept?.departmentHeadName?.trim() && (
                                    <p className="text-xs text-muted-foreground">
                                        Current: {selectedDept.departmentHeadName.trim()}
                                    </p>
                                )}
                            </div>
                            {/* <Button size="sm" variant="soft" className='mt-3' onClick={saveDeptHead} disabled={!deptChanged || saving !== null}>
                                <Save className="mr-0.5 h-3.5 w-3.5" />
                                {saving === 'dept' ? 'Saving...' : 'Save'}
                            </Button> */}
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* ── Bulk Save All ────────────────────────────────────────── */}
            </div>

            {changeCount > 0 && (
                <Card className="border-warning/30 bg-warning/5">
                    <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                            <p className="text-sm font-medium">{changeCount} pending {changeCount === 1 ? 'assignment' : 'assignments'}</p>
                            <p className="text-sm text-muted-foreground">
                                {Object.values(pendingChanges).map((c) => c.name).join(', ')}
                            </p>
                        </div>
                        <Button variant="soft" onClick={saveAll} disabled={saving !== null}>
                            {saving === 'all' ? 'Saving...' : `Save All (${changeCount})`}
                        </Button>
                    </CardContent>
                </Card>
            )}
        </div>
    )
}
