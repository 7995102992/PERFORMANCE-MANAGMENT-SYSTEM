export type PermissionRole = 'admin' | 'editor' | 'viewer'

export type PermissionAction = 'create' | 'read' | 'update' | 'delete' | 'export'

export interface PermissionMatrix {
    action: PermissionAction
    admin: boolean
    editor: boolean
    viewer: boolean
}

export interface Policy {
    id: string
    name: string
    moduleId: string
    moduleName: string
    permissions: PermissionRole[]
    permissionMatrix?: PermissionMatrix[]
    is_active: boolean
    is_role: boolean
    createdAt: string
}

export interface PolicyAssignment {
    id: string
    employeeName: string
    email: string
    moduleId: string
    moduleName: string
    assignedPolicyId: string
    assignedPolicyName: string
    assignedOn: string
}
