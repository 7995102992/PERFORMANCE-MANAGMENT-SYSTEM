import { z } from "zod"

export type DepartmentStatus = "active" | "inactive"

export interface Department {
    id: string
    name: string
    head: {
        name: string
        avatar?: string
    }
    employeeCount: number
    status: DepartmentStatus
    businessUnits: string[]
}

export const departmentFormSchema = z.object({
    name: z.string().min(1, "Department name is required"),
    headId: z.string().min(1, "Department head is required"),
    businessUnits: z.array(z.string()).min(1, "At least one business unit is required"),
    status: z.enum(["active", "inactive"]).default("active"),
})

export type DepartmentFormValues = z.infer<typeof departmentFormSchema>
