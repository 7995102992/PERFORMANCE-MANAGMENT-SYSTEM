import * as React from 'react'
import type { ElementType } from 'react'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
    Search, Copy, Loader2,
    Users, CalendarCheck, Calendar, CircleDollarSign, TrendingUp,
    UserPlus, GraduationCap, Receipt, Package, Headphones, Clock, BarChart3,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { useConfirm } from '@/providers/confirm-dialog-provider'
import { SearchableSelect } from '@/components/shared/SearchableSelect'
import { useQueries } from '@tanstack/react-query'
import { useModules, useAcl, usePermissionsByModule } from '@/hooks/queries/use-lookups'
import { queryKeys } from '@/api/query-keys'
import { lookupsService } from '@/api/lookups'
import type { PolicyPermissionsMap } from '@/api/org-setup/types'
import type { AclLookupDTO } from '@/api/lookups'

const MODULE_ICONS: Record<string, ElementType> = {
    core_hr: Users,
    attendance_management: CalendarCheck,
    leave_management: Calendar,
    payroll: CircleDollarSign,
    performance_management: TrendingUp,
    recruitment: UserPlus,
    training_and_development: GraduationCap,
    expense_management: Receipt,
    asset_management: Package,
    service_request: Headphones,
    timesheet_management: Clock,
    reports_and_analytics: BarChart3,
}

// Modules where only certain ACL roles can be granted. Any role not listed
// here renders as a disabled checkbox (e.g. Reports & Analytics is view-only —
// Editor/Admin make no sense for it). Modules absent from this map allow all roles.
const MODULE_ALLOWED_ROLES: Record<string, string[]> = {
    reports_and_analytics: ['viewer'],
}

function isRoleAllowed(moduleCode: string, roleName: string): boolean {
    const allowed = MODULE_ALLOWED_ROLES[moduleCode]
    return !allowed || allowed.includes(roleName)
}

// matrix[permCode][roleName] = boolean
type DynamicMatrix = Record<string, Record<string, boolean>>
// allMatrices[moduleCode] = DynamicMatrix
type AllModuleMatrices = Record<string, DynamicMatrix>

function allMatricesToPermissionsMap(matrices: AllModuleMatrices, roles: AclLookupDTO[]): PolicyPermissionsMap {
    const result: PolicyPermissionsMap = {}
    for (const [modId, matrix] of Object.entries(matrices)) {
        const permCodes = Object.keys(matrix)
        const hasAnyTrue = permCodes.some((pc) => roles.some((r) => matrix[pc]?.[r.role]))
        if (!hasAnyTrue) continue
        const modulePerms: Record<string, Record<string, boolean>> = {}
        for (const r of roles) {
            modulePerms[r.role] = {}
            for (const pc of permCodes) {
                modulePerms[r.role][pc] = matrix[pc]?.[r.role] ?? false
            }
        }
        result[modId] = modulePerms
    }
    return result
}

function permissionsMapToAllMatrices(permMap: PolicyPermissionsMap, roles: AclLookupDTO[]): AllModuleMatrices {
    const result: AllModuleMatrices = {}
    for (const [modId, modulePerms] of Object.entries(permMap)) {
        const matrix: DynamicMatrix = {}
        const permCodes = new Set<string>()
        for (const r of roles) {
            if (modulePerms[r.role]) {
                for (const pc of Object.keys(modulePerms[r.role])) permCodes.add(pc)
            }
        }
        for (const pc of permCodes) {
            matrix[pc] = {}
            for (const r of roles) matrix[pc][r.role] = modulePerms[r.role]?.[pc] ?? false
        }
        result[modId] = matrix
    }
    return result
}

export interface PermissionGridEditorRef {
    getGrid: () => PolicyPermissionsMap
}

interface Props {
    /** Initial grid (edit mode); applied once it loads while the editor is still pristine. */
    initialGrid?: PolicyPermissionsMap
    disabled?: boolean
    onDirty?: () => void
    /** Designations the user can copy permissions from. */
    copyOptions?: { label: string; value: string }[]
    /** Fetch a designation's policy grid to copy in. */
    onCopyFrom?: (designationId: string) => Promise<PolicyPermissionsMap | null>
}

export const PermissionGridEditor = React.forwardRef<PermissionGridEditorRef, Props>(
    function PermissionGridEditor({ initialGrid, disabled = false, onDirty, copyOptions, onCopyFrom }, ref) {
        const confirm = useConfirm()
        const [allMatrices, setAllMatrices] = React.useState<AllModuleMatrices>({})
        const [activeModule, setActiveModule] = React.useState('')
        const [searchPerm, setSearchPerm] = React.useState('')
        const [isCopying, setIsCopying] = React.useState(false)
        const dirtyRef = React.useRef(false)

        const { data: modules = [], isLoading: modulesLoading } = useModules()
        const { data: roles = [] } = useAcl()
        const { data: modulePermissions = [] } = usePermissionsByModule(activeModule)

        // Warm the cache for every module's permissions up-front so switching
        // tabs is instant — avoids the per-tab fetch flicker. Shares the same
        // query keys as usePermissionsByModule; cached indefinitely (static data).
        useQueries({
            queries: modules.map((m) => ({
                queryKey: [...queryKeys.lookups.permissions, m.code],
                queryFn: () => lookupsService.permissions(m.code),
                staleTime: Infinity,
                gcTime: Infinity,
            })),
        })

        React.useImperativeHandle(ref, () => ({
            getGrid: () => allMatricesToPermissionsMap(allMatrices, roles),
        }), [allMatrices, roles])

        const markDirty = () => { dirtyRef.current = true; onDirty?.() }

        const sortedModules = React.useMemo(
            () => [...modules].sort((a, b) => {
                if (a.mandatory !== b.mandatory) return a.mandatory ? -1 : 1
                return a.label.localeCompare(b.label)
            }),
            [modules],
        )

        // Pick the first module once modules load.
        React.useEffect(() => {
            if (!activeModule && sortedModules.length > 0) setActiveModule(sortedModules[0].code)
        }, [sortedModules, activeModule])

        // Seed from initialGrid while the editor is still pristine (handles async load on edit).
        React.useEffect(() => {
            if (dirtyRef.current || !initialGrid || roles.length === 0) return
            setAllMatrices(permissionsMapToAllMatrices(initialGrid, roles))
        }, [initialGrid, roles])

        // Ensure matrix rows exist for the active module's permissions.
        React.useEffect(() => {
            if (!activeModule || modulePermissions.length === 0 || roles.length === 0) return
            setAllMatrices((prev) => {
                const existing = prev[activeModule] ?? {}
                const updated = { ...existing }
                let changed = false
                for (const p of modulePermissions) {
                    if (!updated[p.code]) {
                        updated[p.code] = {}
                        for (const r of roles) updated[p.code][r.role] = false
                        changed = true
                    }
                }
                return changed ? { ...prev, [activeModule]: updated } : prev
            })
        }, [activeModule, modulePermissions, roles])

        const filteredPermissions = React.useMemo(() => {
            if (!searchPerm.trim()) return modulePermissions
            return modulePermissions.filter((p) => p.label.toLowerCase().includes(searchPerm.toLowerCase()))
        }, [modulePermissions, searchPerm])

        function toggleAllForRole(roleName: string) {
            if (!activeModule || modulePermissions.length === 0) return
            if (!isRoleAllowed(activeModule, roleName)) return
            const modMatrix = allMatrices[activeModule] ?? {}
            const allChecked = modulePermissions.every((p) => modMatrix[p.code]?.[roleName])
            setAllMatrices((prev) => {
                const updated = { ...prev[activeModule] }
                for (const p of modulePermissions) {
                    updated[p.code] = { ...updated[p.code], [roleName]: !allChecked }
                }
                return { ...prev, [activeModule]: updated }
            })
            markDirty()
        }

        function toggleCell(permCode: string, roleName: string) {
            if (!isRoleAllowed(activeModule, roleName)) return
            setAllMatrices((prev) => ({
                ...prev,
                [activeModule]: {
                    ...prev[activeModule],
                    [permCode]: { ...prev[activeModule]?.[permCode], [roleName]: !prev[activeModule]?.[permCode]?.[roleName] },
                },
            }))
            markDirty()
        }

        function gridHasAnyPermission() {
            return Object.values(allMatrices).some((m) =>
                Object.values(m).some((roleMap) => Object.values(roleMap).some(Boolean)),
            )
        }

        function applyCopiedGrid(grid: PolicyPermissionsMap, sourceName: string) {
            setAllMatrices(permissionsMapToAllMatrices(grid, roles))
            markDirty()
            toast.success(`Permissions copied from "${sourceName}"`)
        }

        async function handleCopyFrom(sourceId: string) {
            if (!sourceId || !onCopyFrom) return
            const sourceName = copyOptions?.find((o) => o.value === sourceId)?.label ?? 'that role'
            setIsCopying(true)
            let grid: PolicyPermissionsMap | null = null
            try {
                grid = await onCopyFrom(sourceId)
            } finally {
                setIsCopying(false)
            }
            if (!grid || Object.keys(grid).length === 0) {
                toast.error(`"${sourceName}" has no permissions to copy`)
                return
            }
            // Replacing a non-empty grid is destructive — confirm first.
            if (gridHasAnyPermission()) {
                confirm({
                    title: 'Replace current permissions?',
                    description: `This overwrites the permissions you've set with those from "${sourceName}". This can't be undone.`,
                    confirmText: 'Replace',
                    variant: 'destructive',
                    onConfirm: async () => applyCopiedGrid(grid!, sourceName),
                })
            } else {
                applyCopiedGrid(grid, sourceName)
            }
        }

        // Modules drive the whole grid — show a small loader while they load so
        // the editor doesn't flash an empty/janky state when a role opens.
        if (modulesLoading && modules.length === 0) {
            return (
                <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                    <Loader2 className="size-5 animate-spin" />
                    Loading permissions…
                </div>
            )
        }

        return (
            <div className="space-y-4">
                {/* Copy-from-designation — applies to the whole grid (all modules) */}
                {!disabled && copyOptions && copyOptions.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border bg-muted/20 px-3 py-2">
                        <Copy className="size-4 text-muted-foreground" />
                        <span className="text-sm text-muted-foreground whitespace-nowrap">
                            Copy all permissions from
                        </span>
                        <div className="w-64">
                            <SearchableSelect
                                options={copyOptions}
                                value=""
                                onChange={handleCopyFrom}
                                placeholder={isCopying ? 'Copying…' : 'Select a role…'}
                                disabled={isCopying}
                            />
                        </div>
                    </div>
                )}

                {/* Module cards */}
                <div>
                    <p className="text-sm font-medium mb-3">{disabled ? 'Module' : 'Select a module'}</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                        {sortedModules.map((m) => {
                            const Icon = MODULE_ICONS[m.code] ?? Package
                            const isActive = activeModule === m.code
                            return (
                                <button
                                    key={m.code}
                                    type="button"
                                    onClick={() => setActiveModule(m.code)}
                                    className={cn(
                                        'relative flex flex-col gap-2 rounded-lg border p-4 text-left transition-all min-h-[110px]',
                                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                        isActive ? 'border-border bg-muted/30' : 'border-border bg-card hover:border-foreground/20 hover:shadow-sm',
                                    )}
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div className={cn(
                                            'flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors',
                                            isActive ? 'bg-icon-bg text-icon' : 'bg-muted text-muted-foreground',
                                        )}>
                                            <Icon className="size-5" />
                                        </div>
                                        <div className={cn(
                                            'flex size-5 shrink-0 items-center justify-center rounded border-2 transition-colors',
                                            isActive ? 'border-foreground bg-foreground text-background' : 'border-muted-foreground/40 bg-background',
                                        )}>
                                            {isActive && (
                                                <svg viewBox="0 0 12 10" className="size-3 fill-none stroke-current stroke-2">
                                                    <polyline points="1,5 4,8 11,1" />
                                                </svg>
                                            )}
                                        </div>
                                    </div>
                                    <div>
                                        <p className="text-sm font-semibold leading-tight">{m.label}</p>
                                        {m.description && (
                                            <p className="mt-0.5 text-xs text-muted-foreground leading-snug">{m.description}</p>
                                        )}
                                    </div>
                                    {m.mandatory && (
                                        <Badge className="w-fit bg-muted text-muted-foreground border-border text-[10px] px-2 py-0">Mandatory</Badge>
                                    )}
                                </button>
                            )
                        })}
                    </div>
                </div>

                {/* Matrix */}
                {activeModule && (
                    <div className="space-y-4">
                        {!disabled && (
                            <div className="relative max-w-sm">
                                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-icon" />
                                <Input
                                    placeholder="Search permissions...."
                                    value={searchPerm}
                                    onChange={(e) => setSearchPerm(e.target.value)}
                                    className="pl-9"
                                />
                            </div>
                        )}

                        <div className="rounded-lg border overflow-hidden">
                            <Table>
                                <TableHeader>
                                    <TableRow className="border-b border-border/50 bg-muted/30 hover:bg-muted/30">
                                        <TableHead className="w-[220px] min-w-[180px] px-4 py-2.5 text-left text-xs font-semibold tracking-wider text-muted-foreground">
                                            Permission
                                        </TableHead>
                                        {roles.map((role) => (
                                            <TableHead key={role.role} className="min-w-[110px] px-4 py-2.5 text-center text-xs font-semibold tracking-wider text-foreground/80">
                                                {role.label}
                                            </TableHead>
                                        ))}
                                    </TableRow>
                                    {!disabled && (
                                        <TableRow className="border-b border-border bg-muted/50 hover:bg-muted/50">
                                            <TableHead className="px-4 py-2.5 text-xs font-medium text-muted-foreground/70">Select all</TableHead>
                                            {roles.map((role) => {
                                                const modMatrix = allMatrices[activeModule] ?? {}
                                                const allChecked = modulePermissions.length > 0 && modulePermissions.every((p) => modMatrix[p.code]?.[role.role])
                                                return (
                                                    <TableHead key={role.role} className="px-4 py-2.5">
                                                        <div className="flex justify-center">
                                                            <Checkbox checked={allChecked} disabled={!isRoleAllowed(activeModule, role.role)} onCheckedChange={() => toggleAllForRole(role.role)} aria-label={`Select all for ${role.label}`} />
                                                        </div>
                                                    </TableHead>
                                                )
                                            })}
                                        </TableRow>
                                    )}
                                </TableHeader>
                                <TableBody>
                                    {filteredPermissions.length === 0 ? (
                                        <TableRow>
                                            <TableCell colSpan={1 + roles.length} className="h-16 text-center text-muted-foreground">
                                                No permissions match your search.
                                            </TableCell>
                                        </TableRow>
                                    ) : (
                                        filteredPermissions.map((perm, idx) => {
                                            const modMatrix = allMatrices[activeModule] ?? {}
                                            return (
                                                <TableRow key={perm.code} className={idx % 2 === 1 ? 'bg-muted/[0.15]' : ''}>
                                                    <TableCell className="px-4 py-3 text-sm font-medium text-foreground/90">{perm.label}</TableCell>
                                                    {roles.map((role) => {
                                                        const checked = modMatrix[perm.code]?.[role.role] ?? false
                                                        return (
                                                            <TableCell key={role.role} className="px-4 py-3">
                                                                <div className="flex justify-center">
                                                                    {disabled ? (
                                                                        <div className={cn(
                                                                            'flex size-5 shrink-0 items-center justify-center rounded border-2',
                                                                            checked ? 'border-foreground bg-foreground text-background' : 'border-muted-foreground/30 bg-background',
                                                                        )}>
                                                                            {checked && (
                                                                                <svg viewBox="0 0 12 10" className="size-3 fill-none stroke-current stroke-2">
                                                                                    <polyline points="1,5 4,8 11,1" />
                                                                                </svg>
                                                                            )}
                                                                        </div>
                                                                    ) : (
                                                                        <Checkbox checked={checked} disabled={!isRoleAllowed(activeModule, role.role)} onCheckedChange={() => toggleCell(perm.code, role.role)} />
                                                                    )}
                                                                </div>
                                                            </TableCell>
                                                        )
                                                    })}
                                                </TableRow>
                                            )
                                        })
                                    )}
                                </TableBody>
                            </Table>
                        </div>
                    </div>
                )}
            </div>
        )
    },
)
