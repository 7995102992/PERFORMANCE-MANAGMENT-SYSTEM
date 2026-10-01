import { Package, ShieldCheck } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ModuleManagementPage } from "@/modules/org-setup/pages/ModuleManagement"
import { OrgAdminsPage } from "@/modules/org-setup/pages/OrgAdmins"

export function SettingsPage() {
  return (
    <div className="space-y-6 p-6">

      <h1 className="text-xl font-semibold">Settings</h1>

      <Tabs defaultValue="modules">
        <TabsList>
          <TabsTrigger value="modules" className="gap-2">
            <Package className="size-4" />
            Modules
          </TabsTrigger>
          <TabsTrigger value="org-admins" className="gap-2">
            <ShieldCheck className="size-4" />
            Org Admins
          </TabsTrigger>
        </TabsList>

        <TabsContent value="modules">
          <ModuleManagementPage />
        </TabsContent>

        <TabsContent value="org-admins">
          <OrgAdminsPage />
        </TabsContent>
      </Tabs>

    </div>
  )
}
