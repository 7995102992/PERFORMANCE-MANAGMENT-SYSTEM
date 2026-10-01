import { z } from "zod"

export const departmentModelSchema = z.object({
    businessUnits: z.array(z.string()).min(1, "At least one Business Unit is required"),
    primaryBusinessUnit: z.string().optional().default(""),
    departmentName: z.string().min(1, "Department Name is required").max(100),
    departmentCode: z.string().min(1, "Department Code is required").max(20),
    description: z.string().optional().default(""),
    departmentHead: z.string().optional().default(""),
    departmentHeadName: z.string().optional().default(""),
    status: z.boolean().default(true),
})

export type DepartmentModelForm = z.infer<typeof departmentModelSchema>

interface DepartmentModelBase {
    open: boolean
    onOpenChange: (open: boolean) => void
}

export interface DepartmentModelAddProps extends DepartmentModelBase {
    mode: "add"
    onSave: (data: DepartmentModelForm) => void
}

export interface DepartmentModelEditProps extends DepartmentModelBase {
    mode: "edit"
    data: DepartmentModelForm
    onSave: (data: DepartmentModelForm) => void
}

export interface DepartmentModelViewProps extends DepartmentModelBase {
    mode: "view"
    data: DepartmentModelForm
    /** Switch from view to edit mode (shows a top-right Edit button) */
    onEdit?: () => void
}

export type DepartmentModelProps = DepartmentModelAddProps | DepartmentModelEditProps | DepartmentModelViewProps
