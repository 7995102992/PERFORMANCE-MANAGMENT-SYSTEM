import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { GraduationCap, Rows3, BadgeDollarSign, ShieldCheck } from 'lucide-react'
import { DesignationsPage } from './DesignationsPage'
import { BandsPage } from '../Bands/BandsPage'
import { PayGradesPage } from '../PayGrades/PayGradesPage'
import { RolesPage } from '../Roles/RolesPage'
import { useRegisterWizardTabs } from '@/modules/org-setup/wizard-tab-context'

const TABS = ['bands', 'pay-grades', 'designations', 'roles']

export function DesignationsLayout() {
  const { activeTab, setActiveTab } = useRegisterWizardTabs(TABS)

  return (
    <div className="p-6">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="bands" className="gap-2"><Rows3 className="size-4" />Bands</TabsTrigger>
          <TabsTrigger value="pay-grades" className="gap-2"><BadgeDollarSign className="size-4" />Pay Grades</TabsTrigger>
          <TabsTrigger value="designations" className="gap-2"><GraduationCap className="size-4" />Designations</TabsTrigger>
          <TabsTrigger value="roles" className="gap-2"><ShieldCheck className="size-4" />Roles</TabsTrigger>
        </TabsList>

        <TabsContent value="bands" className="-mx-6 -mt-2">
          <BandsPage />
        </TabsContent>

        <TabsContent value="pay-grades" className="-mx-6 -mt-2">
          <PayGradesPage />
        </TabsContent>

        <TabsContent value="designations" className="-mx-6 -mt-2">
          <DesignationsPage />
        </TabsContent>

        <TabsContent value="roles" className="-mx-6 -mt-2">
          <RolesPage />
        </TabsContent>
      </Tabs>
    </div>
  )
}
