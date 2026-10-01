import { useGetMyJourneyQuery } from '@/store/api/employeeJourneyApi'
import { JourneyView } from './JourneyView'

export default function MyJourney() {
  const { data, isLoading, isError, isFetching, refetch } = useGetMyJourneyQuery()

  return (
    // Just the timeline card, filling all available space — no header, no window scroll.
    <div className="flex h-[calc(100svh-7rem)] flex-col overflow-hidden rounded-xl border bg-card">
      <JourneyView
        events={data?.timeline ?? []}
        isLoading={isLoading}
        isError={isError}
        isFetching={isFetching}
        onRetry={refetch}
        emptyDescription="Your milestones will appear here as they happen — onboarding, role changes, projects and more."
      />
    </div>
  )
}
