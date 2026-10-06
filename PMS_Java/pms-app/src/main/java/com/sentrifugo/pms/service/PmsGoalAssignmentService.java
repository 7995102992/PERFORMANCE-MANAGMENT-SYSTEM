package com.sentrifugo.pms.service;

import com.sentrifugo.common.exception.DomainException;
import com.sentrifugo.db.entity.PmsGoalAssignmentEntity;
import com.sentrifugo.db.entity.PmsGoalAssignmentTargetEntity;
import com.sentrifugo.db.entity.PmsGoalTemplateEntity;
import com.sentrifugo.db.entity.PmsGoalTemplateKpiEntity;
import com.sentrifugo.db.entity.PmsKpiMasterEntity;
import com.sentrifugo.db.enums.PmsAssignmentStatus;
import com.sentrifugo.db.enums.PmsTemplateStatus;
import com.sentrifugo.db.repository.PmsGoalAssignmentRepository;
import com.sentrifugo.db.repository.PmsGoalAssignmentTargetRepository;
import com.sentrifugo.db.repository.PmsGoalTemplateKpiRepository;
import com.sentrifugo.db.repository.PmsGoalTemplateRepository;
import com.sentrifugo.pms.integration.IamEmployee;
import com.sentrifugo.pms.integration.IamEmployeeClient;
import com.sentrifugo.pms.model.PmsApprovalActionRequest;
import com.sentrifugo.pms.model.PmsApprovalItemResponse;
import com.sentrifugo.pms.model.PmsChangeRequest;
import com.sentrifugo.pms.model.PmsEmployeeTargetsResponse;
import com.sentrifugo.pms.model.PmsGoalDecisionRequest;
import com.sentrifugo.pms.model.PmsTargetValidationResponse;
import com.sentrifugo.pms.model.PmsTargetsRequest;
import com.sentrifugo.pms.model.PmsTeamMemberResponse;
import com.sentrifugo.security.context.PmsUserPrincipal;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/** Goal assignment by the manager (screens 3.1 - 3.5) and the approval steps after it (4.x, 5.x). */
@Slf4j
@Service
@RequiredArgsConstructor
public class PmsGoalAssignmentService {

    /** Goal state before any targets are saved for the employee. */
    static final String NOT_STARTED = "not_started";

    private static final BigDecimal HUNDRED = BigDecimal.valueOf(100);
    private static final BigDecimal TOLERANCE = new BigDecimal("0.01");
    private static final List<PmsAssignmentStatus> HOD_QUEUE =
            List.of(PmsAssignmentStatus.ACKNOWLEDGED, PmsAssignmentStatus.WITH_HOD);

    private final IamEmployeeClient iam;
    private final PmsGoalAssignmentRepository assignmentRepository;
    private final PmsGoalAssignmentTargetRepository targetRepository;
    private final PmsGoalTemplateRepository templateRepository;
    private final PmsGoalTemplateKpiRepository templateKpiRepository;

    /** Screen 3.1 "My Team": the caller's direct reports with their goal status. */
    @Transactional(readOnly = true)
    public List<PmsTeamMemberResponse> getTeam(PmsUserPrincipal manager, String financialYear) {
        List<IamEmployee> reports = iam.directReports(manager.accessToken(), manager.id());
        Map<String, PmsAssignmentStatus> statusByEmployee = new HashMap<>();
        if (!reports.isEmpty()) {
            List<String> ids = reports.stream().map(IamEmployee::userId).toList();
            for (PmsGoalAssignmentEntity a : assignmentRepository
                    .findByOrganisationIdAndFinancialYearAndEmployeeUserIdIn(
                            manager.organisationId(), financialYear, ids)) {
                statusByEmployee.put(a.getEmployeeUserId(), a.getStatus());
            }
        }
        return reports.stream()
                .map(e -> toTeamMember(e, statusByEmployee.get(e.userId())))
                .toList();
    }

    /** Screens 3.2 and 3.3: the employee's template KPIs with any targets already saved. */
    @Transactional(readOnly = true)
    public PmsEmployeeTargetsResponse getEmployeeTargets(PmsUserPrincipal manager, String employeeUserId,
                                                         String financialYear) {
        IamEmployee employee = requireTeamMember(manager, employeeUserId);
        PmsGoalTemplateEntity template = requireTemplate(manager, employee, financialYear);
        Optional<PmsGoalAssignmentEntity> assignment = assignmentRepository
                .findByOrganisationIdAndEmployeeUserIdAndFinancialYear(manager.organisationId(), employeeUserId,
                        financialYear);
        return view(assignment, template, employeeUserId, financialYear);
    }

    /** Screen 4.1 "My Goals": the signed-in employee's own targets for the year. */
    @Transactional(readOnly = true)
    public PmsEmployeeTargetsResponse getMyGoals(PmsUserPrincipal employee, String financialYear) {
        Optional<PmsGoalAssignmentEntity> assignment = assignmentRepository
                .findByOrganisationIdAndEmployeeUserIdAndFinancialYear(employee.organisationId(), employee.id(),
                        financialYear);
        if (assignment.isEmpty()) {
            throw DomainException.notFound("No goals have been set for you for " + financialYear,
                    "PMS_GOALS_NOT_FOUND");
        }
        PmsGoalTemplateEntity template = templateRepository.findById(assignment.get().getTemplateId())
                .orElseThrow(() -> DomainException.notFound("Goal template not found", "PMS_TEMPLATE_NOT_FOUND"));
        return view(assignment, template, employee.id(), financialYear);
    }

    /** Screen 4.3 "Acknowledge and submit": the employee accepts the goals sent to them. */
    @Transactional
    public PmsEmployeeTargetsResponse acknowledge(PmsUserPrincipal employee, PmsGoalDecisionRequest request) {
        PmsGoalAssignmentEntity a = requireAssignment(employee.organisationId(), employee.id(),
                request.financialYear());
        requireStatus(a, PmsAssignmentStatus.SENT_TO_EMPLOYEE, "Only goals sent to you can be acknowledged.");
        a.setStatus(PmsAssignmentStatus.ACKNOWLEDGED);
        a.setAcknowledgedOn(LocalDateTime.now());
        assignmentRepository.save(a);
        log.info("Employee {} acknowledged goals for {}", employee.id(), request.financialYear());
        return getMyGoals(employee, request.financialYear());
    }

    /** Screen 4.2 "Request change": the employee asks the manager to revise one target. */
    @Transactional
    public PmsEmployeeTargetsResponse requestChange(PmsUserPrincipal employee, PmsChangeRequest request) {
        PmsGoalAssignmentEntity a = requireAssignment(employee.organisationId(), employee.id(),
                request.financialYear());
        requireStatus(a, PmsAssignmentStatus.SENT_TO_EMPLOYEE, "Only goals sent to you can be questioned.");
        a.setStatus(PmsAssignmentStatus.CHANGE_REQUESTED);
        a.setChangeKpiId(request.kpiId());
        a.setChangeProposedTarget(request.proposedTarget());
        a.setChangeReason(request.reason().trim());
        a.setChangeRequestedOn(LocalDateTime.now());
        assignmentRepository.save(a);
        log.info("Employee {} requested a change for {}", employee.id(), request.financialYear());
        return getMyGoals(employee, request.financialYear());
    }

    /** Screen 5.1 "Team Goals Settings" (HOD): every sheet waiting for HOD approval. */
    @Transactional(readOnly = true)
    public List<PmsApprovalItemResponse> approvalQueue(PmsUserPrincipal hod, String financialYear) {
        return assignmentRepository.findByOrganisationIdAndFinancialYearAndStatusIn(
                        hod.organisationId(), financialYear, HOD_QUEUE)
                .stream()
                .map(a -> new PmsApprovalItemResponse(a.getEmployeeUserId(), a.getEmployeeName(), a.getEmpCode(),
                        a.getDesignationName(), a.getManagerUserId(), wire(a.getStatus())))
                .toList();
    }

    /** Screen 5.2 approve: the HOD approves the employee's goals. */
    @Transactional
    public PmsEmployeeTargetsResponse approve(PmsUserPrincipal hod, PmsApprovalActionRequest request) {
        PmsGoalAssignmentEntity a = requireAssignment(hod.organisationId(), request.employeeUserId(),
                request.financialYear());
        if (!HOD_QUEUE.contains(a.getStatus())) {
            throw DomainException.unprocessable("These goals are not waiting for HOD approval.",
                    "PMS_NOT_AWAITING_HOD");
        }
        a.setStatus(PmsAssignmentStatus.APPROVED);
        a.setApprovedOn(LocalDateTime.now());
        a.setHodRemarks(blankToNull(request.remarks()));
        assignmentRepository.save(a);
        return view(Optional.of(a), requireTemplateById(a), a.getEmployeeUserId(), request.financialYear());
    }

    /** Screen 5.2 return: the HOD sends the goals back to the manager to revise. */
    @Transactional
    public PmsEmployeeTargetsResponse returnToManager(PmsUserPrincipal hod, PmsApprovalActionRequest request) {
        PmsGoalAssignmentEntity a = requireAssignment(hod.organisationId(), request.employeeUserId(),
                request.financialYear());
        if (!HOD_QUEUE.contains(a.getStatus())) {
            throw DomainException.unprocessable("These goals are not waiting for HOD approval.",
                    "PMS_NOT_AWAITING_HOD");
        }
        a.setStatus(PmsAssignmentStatus.DRAFT);
        a.setHodRemarks(blankToNull(request.remarks()));
        assignmentRepository.save(a);
        return view(Optional.of(a), requireTemplateById(a), a.getEmployeeUserId(), request.financialYear());
    }

    /** Screen 3.3 "Save Draft": stores the targets as given. Incomplete drafts are allowed. */
    @Transactional
    public PmsEmployeeTargetsResponse saveDraft(PmsUserPrincipal manager, PmsTargetsRequest request) {
        IamEmployee employee = requireTeamMember(manager, request.employeeUserId());
        PmsGoalTemplateEntity template = requireTemplate(manager, employee, request.financialYear());
        Map<UUID, PmsKpiMasterEntity> allowed = allowedKpis(template);
        checkKpisBelong(request, allowed);

        PmsGoalAssignmentEntity assignment = assignmentRepository
                .findByOrganisationIdAndEmployeeUserIdAndFinancialYear(manager.organisationId(),
                        request.employeeUserId(), request.financialYear())
                .orElseGet(() -> PmsGoalAssignmentEntity.builder()
                        .organisationId(manager.organisationId())
                        .employeeUserId(request.employeeUserId())
                        .managerUserId(manager.id())
                        .financialYear(request.financialYear())
                        .build());
        assignment.setTemplateId(template.getId());
        assignment.setEmployeeName(fullName(employee));
        assignment.setEmpCode(employee.empCode());
        assignment.setDesignationName(employee.designationName());
        assignment.setStatus(PmsAssignmentStatus.DRAFT);
        assignment = assignmentRepository.save(assignment);

        targetRepository.deleteByAssignmentId(assignment.getId());
        targetRepository.flush();
        for (PmsTargetsRequest.Target t : request.targets()) {
            targetRepository.save(PmsGoalAssignmentTargetEntity.builder()
                    .assignment(assignment)
                    .kpi(allowed.get(t.kpiId()))
                    .weight(t.weight())
                    .target(t.target())
                    .build());
        }
        log.info("Saved draft targets for employee {} ({} KPIs)", request.employeeUserId(), request.targets().size());
        return getEmployeeTargets(manager, request.employeeUserId(), request.financialYear());
    }

    /** Screen 3.4 "Validate": the checks a send needs to pass. Writes nothing. */
    @Transactional(readOnly = true)
    public PmsTargetValidationResponse validate(PmsUserPrincipal manager, PmsTargetsRequest request) {
        IamEmployee employee = requireTeamMember(manager, request.employeeUserId());
        PmsGoalTemplateEntity template = requireTemplate(manager, employee, request.financialYear());
        Map<UUID, PmsKpiMasterEntity> allowed = allowedKpis(template);
        checkKpisBelong(request, allowed);

        List<String> errors = new ArrayList<>();
        BigDecimal total = BigDecimal.ZERO;
        for (PmsTargetsRequest.Target t : request.targets()) {
            String kpiName = allowed.get(t.kpiId()).getName();
            total = total.add(t.weight());
            if (t.weight().signum() <= 0) {
                errors.add("Weight for " + kpiName + " must be above 0");
            }
            if (t.target() == null) {
                errors.add("Target missing for " + kpiName);
            }
        }
        if (total.subtract(HUNDRED).abs().compareTo(TOLERANCE) > 0) {
            errors.add("Total weightage is " + total.stripTrailingZeros().toPlainString() + "% (must be 100%)");
        }
        return new PmsTargetValidationResponse(errors.isEmpty(), total, errors);
    }

    /**
     * Screen 3.5 "Save and Send": refuses to send unless validation passes, then saves the
     * targets and marks them sent for the employee to acknowledge.
     */
    @Transactional
    public PmsEmployeeTargetsResponse send(PmsUserPrincipal manager, PmsTargetsRequest request) {
        PmsTargetValidationResponse check = validate(manager, request);
        if (!check.valid()) {
            throw new DomainException(String.join("; ", check.errors()), "PMS_TARGETS_INVALID",
                    HttpStatus.UNPROCESSABLE_CONTENT);
        }
        saveDraft(manager, request);
        PmsGoalAssignmentEntity assignment = assignmentRepository
                .findByOrganisationIdAndEmployeeUserIdAndFinancialYear(manager.organisationId(),
                        request.employeeUserId(), request.financialYear())
                .orElseThrow();
        assignment.setStatus(PmsAssignmentStatus.SENT_TO_EMPLOYEE);
        assignment.setSentOn(LocalDateTime.now());
        assignment.setChangeKpiId(null);
        assignment.setChangeReason(null);
        assignment.setChangeProposedTarget(null);
        assignment.setChangeRequestedOn(null);
        assignmentRepository.save(assignment);
        log.info("Sent targets for employee {} for acknowledgement", request.employeeUserId());
        return getEmployeeTargets(manager, request.employeeUserId(), request.financialYear());
    }

    // ── internals ────────────────────────────────────────────────────────────

    /** The employee's targets as a view, used by manager, employee and HOD screens alike. */
    private PmsEmployeeTargetsResponse view(Optional<PmsGoalAssignmentEntity> assignment,
                                            PmsGoalTemplateEntity template, String employeeUserId,
                                            String financialYear) {
        Map<UUID, PmsGoalAssignmentTargetEntity> saved = savedTargets(assignment);
        List<PmsEmployeeTargetsResponse.Kpi> kpis = templateKpiRepository
                .findByTemplateIdOrderByDisplayOrderAsc(template.getId()).stream()
                .map(row -> {
                    PmsGoalAssignmentTargetEntity t = saved.get(row.getKpi().getId());
                    return new PmsEmployeeTargetsResponse.Kpi(
                            row.getKpi().getId(),
                            row.getKra().getName(),
                            row.getKpi().getName(),
                            row.getKpi().getUnit(),
                            row.getKpi().getExpectedOutcome(),
                            row.getKpi().getEvidenceRequired(),
                            t != null ? t.getWeight() : row.getWeightage(),
                            t != null ? t.getTarget() : null);
                })
                .toList();
        PmsGoalAssignmentEntity a = assignment.orElse(null);
        return new PmsEmployeeTargetsResponse(
                employeeUserId,
                financialYear,
                a == null ? NOT_STARTED : wire(a.getStatus()),
                template.getId(),
                template.getTemplateName(),
                kpis,
                a == null ? null : a.getChangeKpiId(),
                a == null ? null : a.getChangeReason(),
                a == null ? null : a.getChangeProposedTarget(),
                a == null ? null : a.getHodRemarks());
    }

    private PmsGoalAssignmentEntity requireAssignment(String organisationId, String employeeUserId,
                                                      String financialYear) {
        return assignmentRepository
                .findByOrganisationIdAndEmployeeUserIdAndFinancialYear(organisationId, employeeUserId, financialYear)
                .orElseThrow(() -> DomainException.notFound("No goals have been set for " + financialYear,
                        "PMS_GOALS_NOT_FOUND"));
    }

    private static void requireStatus(PmsGoalAssignmentEntity a, PmsAssignmentStatus expected, String message) {
        if (a.getStatus() != expected) {
            throw DomainException.unprocessable(message, "PMS_INVALID_GOAL_STATE");
        }
    }

    private PmsGoalTemplateEntity requireTemplateById(PmsGoalAssignmentEntity a) {
        return templateRepository.findById(a.getTemplateId())
                .orElseThrow(() -> DomainException.notFound("Goal template not found", "PMS_TEMPLATE_NOT_FOUND"));
    }

    /** Only the caller's own direct reports may be read or changed. */
    private IamEmployee requireTeamMember(PmsUserPrincipal manager, String employeeUserId) {
        return iam.directReports(manager.accessToken(), manager.id()).stream()
                .filter(e -> employeeUserId.equals(e.userId()))
                .findFirst()
                .orElseThrow(() -> new DomainException("This employee is not in your team.",
                        "PMS_NOT_IN_TEAM", HttpStatus.FORBIDDEN));
    }

    private PmsGoalTemplateEntity requireTemplate(PmsUserPrincipal manager, IamEmployee employee,
                                                  String financialYear) {
        if (employee.designationId() == null) {
            throw DomainException.unprocessable("This employee has no designation, so no template applies.",
                    "PMS_TEMPLATE_NOT_FOUND");
        }
        return templateRepository.findFirstByOrganisationIdAndRoleIdAndFinancialYearAndStatus(
                        manager.organisationId(), employee.designationId(), financialYear, PmsTemplateStatus.ACTIVE)
                .orElseThrow(() -> DomainException.notFound(
                        "No active goal template for this role in " + financialYear, "PMS_TEMPLATE_NOT_FOUND"));
    }

    /** The KPIs the employee's template offers, keyed by id. */
    private Map<UUID, PmsKpiMasterEntity> allowedKpis(PmsGoalTemplateEntity template) {
        Map<UUID, PmsKpiMasterEntity> allowed = new HashMap<>();
        for (PmsGoalTemplateKpiEntity row : templateKpiRepository
                .findByTemplateIdOrderByDisplayOrderAsc(template.getId())) {
            allowed.put(row.getKpi().getId(), row.getKpi());
        }
        return allowed;
    }

    private static void checkKpisBelong(PmsTargetsRequest request, Map<UUID, PmsKpiMasterEntity> allowed) {
        for (PmsTargetsRequest.Target t : request.targets()) {
            if (!allowed.containsKey(t.kpiId())) {
                throw DomainException.unprocessable("kpi_id " + t.kpiId()
                        + " is not part of this employee's goal template", "PMS_KPI_NOT_IN_TEMPLATE");
            }
        }
    }

    private Map<UUID, PmsGoalAssignmentTargetEntity> savedTargets(Optional<PmsGoalAssignmentEntity> assignment) {
        Map<UUID, PmsGoalAssignmentTargetEntity> saved = new HashMap<>();
        assignment.ifPresent(a -> {
            for (PmsGoalAssignmentTargetEntity t : targetRepository.findByAssignmentId(a.getId())) {
                saved.put(t.getKpi().getId(), t);
            }
        });
        return saved;
    }

    private static String fullName(IamEmployee e) {
        return ((e.firstName() == null ? "" : e.firstName()) + " "
                + (e.lastName() == null ? "" : e.lastName())).trim();
    }

    private static PmsTeamMemberResponse toTeamMember(IamEmployee e, PmsAssignmentStatus status) {
        return new PmsTeamMemberResponse(e.userId(), e.empCode(), fullName(e), e.workEmail(), e.designationId(),
                e.designationName(), status == null ? NOT_STARTED : wire(status));
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }

    private static String wire(Enum<?> value) {
        return value.name().toLowerCase(Locale.ROOT);
    }
}
