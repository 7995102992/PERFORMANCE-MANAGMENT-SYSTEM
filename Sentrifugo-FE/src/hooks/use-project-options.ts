/**
 * The clients and projects a claim may be booked against, as a dependent pair.
 *
 * **Client narrows project, and neither is required.** A project belongs to
 * exactly one client, so two independent pickers let somebody file against
 * *Project A* under *Client Y* — a contradiction the expense service will store
 * without complaint, because it only snapshots the refs it is handed. Choosing
 * the client first makes that unrepresentable, and leaving both optional keeps
 * the common case (a claim that belongs to no project at all) a single skip
 * rather than two.
 *
 * **Why not `useGetProjectsQuery` / `useGetClientsQuery`.** Both are admin
 * routes: `GET /projects` is guarded by the same
 * `timesheet_management:manage_projects` grant as `POST /projects`, the bulk
 * import and the export, and `GET /clients` by `manage_clients`. An employee
 * raising a claim holds neither, so both calls 403 and both pickers render empty
 * — with no error, exactly as though the org had no projects. Granting those
 * codes to fill two dropdowns would hand every employee the ability to create and
 * edit projects and clients.
 *
 * `GET /my-timesheets/assigned-projects` needs only `my_timesheet`, which every
 * employee already has. It answers a better question too — *the projects this
 * person is allocated to* — and applies the business-unit / department filter the
 * admin route does not, so it narrows visibility rather than widening it.
 *
 * **The clients are derived, not fetched.** They are the distinct clients of the
 * projects this person is on. That is not a workaround for `/clients` being
 * closed: a client nobody is allocated against has nothing bookable under it, so
 * offering it could only ever lead to an empty project list.
 */
import { useMemo } from 'react'
import type { Option } from '@/components/shared/SearchableSelect'
import { useGetMyAssignedProjectsQuery } from '@/store/api/timesheetApi'

/** A project as the picker needs it, with the client it belongs to. */
interface ProjectOption extends Option {
  clientId: string | null
}

export interface ProjectPicker {
  /** Every client this person has an allocation under, by name. */
  clientOptions: Option[]
  /**
   * Projects under `clientId`, or all of them when no client is chosen.
   *
   * Unfiltered rather than empty on no client, so somebody who knows the project
   * but not which client it sits under can still pick it and have the client
   * follow. The dependency is a convenience, not a gate.
   */
  projectOptions: Option[]
  /** The client that owns `projectId`, for keeping the two fields consistent. */
  clientForProject: (projectId: string) => string | null
  isLoading: boolean
}

export function useProjectPicker(clientId?: string | null): ProjectPicker {
  const { data, isLoading } = useGetMyAssignedProjectsQuery()

  const projects = useMemo<ProjectOption[]>(
    () =>
      (data ?? []).map((project) => ({
        // The code is what people quote in conversation, and the only thing
        // separating two projects a client has named similarly. Appended rather
        // than substituted, because the name is what the list is searched by.
        label: project.code ? `${project.name} (${project.code})` : project.name,
        value: project.id,
        clientId: project.client_id,
      })),
    [data],
  )

  const clientOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const project of data ?? []) {
      // A project whose client did not resolve is still bookable — it just
      // cannot be reached *through* the client picker. Skipped here rather than
      // shown as "Unknown", which would look like a real client to choose.
      if (project.client_id && project.client_name && !seen.has(project.client_id)) {
        seen.set(project.client_id, project.client_name)
      }
    }
    return [...seen].map(([value, label]) => ({ label, value }))
  }, [data])

  const projectOptions = useMemo(
    () =>
      (clientId ? projects.filter((project) => project.clientId === clientId) : projects).map(
        ({ label, value }) => ({ label, value }),
      ),
    [projects, clientId],
  )

  const clientForProject = useMemo(() => {
    const owner = new Map(projects.map((project) => [project.value, project.clientId]))
    return (projectId: string) => owner.get(projectId) ?? null
  }, [projects])

  return { clientOptions, projectOptions, clientForProject, isLoading }
}
