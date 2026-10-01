import { z } from "zod"

export const organizationHeadSchema = z.object({
    organizationHead: z.string().min(1, "Organisation Head is required"),
    businessUnitHead: z.string().min(1, "Business Unit Head is required"),
    departmentHead: z.string().min(1, "Department Head is required"),
})

export type OrganizationHeadFormValues = z.infer<typeof organizationHeadSchema>
