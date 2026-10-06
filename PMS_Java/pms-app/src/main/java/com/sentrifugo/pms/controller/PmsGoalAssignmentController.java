package com.sentrifugo.pms.controller;

import com.sentrifugo.common.web.ApiResponse;
import com.sentrifugo.pms.model.PmsApprovalActionRequest;
import com.sentrifugo.pms.model.PmsApprovalItemResponse;
import com.sentrifugo.pms.model.PmsChangeRequest;
import com.sentrifugo.pms.model.PmsEmployeeTargetsResponse;
import com.sentrifugo.pms.model.PmsGoalDecisionRequest;
import com.sentrifugo.pms.model.PmsTargetValidationResponse;
import com.sentrifugo.pms.model.PmsTargetsRequest;
import com.sentrifugo.pms.model.PmsTeamMemberResponse;
import com.sentrifugo.pms.service.PmsGoalAssignmentService;
import com.sentrifugo.security.access.RequirePermission;
import com.sentrifugo.security.context.PmsUserPrincipal;
import io.swagger.v3.oas.annotations.Operation;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/** Goal assignment by the manager (screens 3.1 - 3.5). */
@RestController
@RequestMapping("${pms.api.base.path}/pms-goal-assignment")
@RequiredArgsConstructor
public class PmsGoalAssignmentController {

    private static final String MODULE = "performance_management";
    private static final String ACTION = "manage_team_goals";

    private final PmsGoalAssignmentService service;

    @GetMapping("/get/team")
    @RequirePermission(module = MODULE, action = ACTION)
    @Operation(summary = "My team (screen 3.1)",
            description = "The caller's direct reports, from IAM, with their goal status for the financial year.")
    public ResponseEntity<ApiResponse<List<PmsTeamMemberResponse>>> getTeam(
            @AuthenticationPrincipal PmsUserPrincipal user,
            @RequestParam(name = "financial_year") String financialYear) {
        List<PmsTeamMemberResponse> team = service.getTeam(user, financialYear);
        return ResponseEntity.ok(ApiResponse.ok(team, "Found " + team.size() + " team members"));
    }

    @GetMapping("/get/employee-targets")
    @RequirePermission(module = MODULE, action = ACTION)
    @Operation(summary = "Employee targets (screens 3.2 and 3.3)",
            description = "The employee's template KPIs with the weights and targets saved so far.")
    public ResponseEntity<ApiResponse<PmsEmployeeTargetsResponse>> getEmployeeTargets(
            @AuthenticationPrincipal PmsUserPrincipal user,
            @RequestParam(name = "employee_user_id") String employeeUserId,
            @RequestParam(name = "financial_year") String financialYear) {
        PmsEmployeeTargetsResponse targets = service.getEmployeeTargets(user, employeeUserId, financialYear);
        return ResponseEntity.ok(ApiResponse.ok(targets, "Targets loaded"));
    }

    @PutMapping("/update/employee-targets")
    @RequirePermission(module = MODULE, action = ACTION)
    @Operation(summary = "Save draft (screen 3.3)",
            description = "Stores the weights and targets as given. Incomplete drafts are allowed.")
    public ResponseEntity<ApiResponse<PmsEmployeeTargetsResponse>> saveDraft(
            @AuthenticationPrincipal PmsUserPrincipal user, @Valid @RequestBody PmsTargetsRequest request) {
        PmsEmployeeTargetsResponse saved = service.saveDraft(user, request);
        return ResponseEntity.ok(ApiResponse.ok(saved, "Draft saved"));
    }

    @PostMapping("/send")
    @RequirePermission(module = MODULE, action = ACTION)
    @Operation(summary = "Save and send for acknowledgement (screen 3.5)",
            description = "Refuses with 422 PMS_TARGETS_INVALID unless the targets validate; otherwise saves them "
                    + "and sends them to the employee.")
    public ResponseEntity<ApiResponse<PmsEmployeeTargetsResponse>> send(
            @AuthenticationPrincipal PmsUserPrincipal user, @Valid @RequestBody PmsTargetsRequest request) {
        PmsEmployeeTargetsResponse sent = service.send(user, request);
        return ResponseEntity.ok(ApiResponse.ok(sent, "Goals sent to the employee for acknowledgement"));
    }

    // ── Employee (4.1 - 4.3) ─────────────────────────────────────────────────

    @GetMapping("/get/my-goals")
    @RequirePermission(module = MODULE, action = "manage_own_goals")
    @Operation(summary = "My goals (screen 4.1)", description = "The signed-in employee's own targets for the year.")
    public ResponseEntity<ApiResponse<PmsEmployeeTargetsResponse>> myGoals(
            @AuthenticationPrincipal PmsUserPrincipal user,
            @RequestParam(name = "financial_year") String financialYear) {
        return ResponseEntity.ok(ApiResponse.ok(service.getMyGoals(user, financialYear), "Goals loaded"));
    }

    @PostMapping("/acknowledge")
    @RequirePermission(module = MODULE, action = "manage_own_goals")
    @Operation(summary = "Acknowledge goals (screen 4.3)",
            description = "The employee accepts the goals that were sent to them.")
    public ResponseEntity<ApiResponse<PmsEmployeeTargetsResponse>> acknowledge(
            @AuthenticationPrincipal PmsUserPrincipal user, @Valid @RequestBody PmsGoalDecisionRequest request) {
        return ResponseEntity.ok(ApiResponse.ok(service.acknowledge(user, request), "Goals acknowledged"));
    }

    @PostMapping("/request-change")
    @RequirePermission(module = MODULE, action = "manage_own_goals")
    @Operation(summary = "Request a change (screen 4.2)",
            description = "The employee asks the manager to revise one target.")
    public ResponseEntity<ApiResponse<PmsEmployeeTargetsResponse>> requestChange(
            @AuthenticationPrincipal PmsUserPrincipal user, @Valid @RequestBody PmsChangeRequest request) {
        return ResponseEntity.ok(ApiResponse.ok(service.requestChange(user, request), "Change requested"));
    }

    // ── HOD (5.1 - 5.2) ──────────────────────────────────────────────────────

    @GetMapping("/get/approvals")
    @RequirePermission(module = MODULE, action = "manage_hod_goal_settings")
    @Operation(summary = "Goals awaiting HOD approval (screen 5.1)")
    public ResponseEntity<ApiResponse<List<PmsApprovalItemResponse>>> approvals(
            @AuthenticationPrincipal PmsUserPrincipal user,
            @RequestParam(name = "financial_year") String financialYear) {
        List<PmsApprovalItemResponse> queue = service.approvalQueue(user, financialYear);
        return ResponseEntity.ok(ApiResponse.ok(queue, "Found " + queue.size() + " sheets awaiting approval"));
    }

    @PostMapping("/approve")
    @RequirePermission(module = MODULE, action = "manage_hod_goal_settings")
    @Operation(summary = "Approve goals (screen 5.2)")
    public ResponseEntity<ApiResponse<PmsEmployeeTargetsResponse>> approve(
            @AuthenticationPrincipal PmsUserPrincipal user, @Valid @RequestBody PmsApprovalActionRequest request) {
        return ResponseEntity.ok(ApiResponse.ok(service.approve(user, request), "Goals approved"));
    }

    @PostMapping("/return")
    @RequirePermission(module = MODULE, action = "manage_hod_goal_settings")
    @Operation(summary = "Return goals to the manager (screen 5.2)")
    public ResponseEntity<ApiResponse<PmsEmployeeTargetsResponse>> returnToManager(
            @AuthenticationPrincipal PmsUserPrincipal user, @Valid @RequestBody PmsApprovalActionRequest request) {
        return ResponseEntity.ok(ApiResponse.ok(service.returnToManager(user, request), "Goals returned to manager"));
    }

    @PostMapping("/validate")
    @RequirePermission(module = MODULE, action = ACTION)
    @Operation(summary = "Validate targets (screen 3.4)",
            description = "Checks weightage totals 100 and every KPI has a numeric target. Writes nothing.")
    public ResponseEntity<ApiResponse<PmsTargetValidationResponse>> validate(
            @AuthenticationPrincipal PmsUserPrincipal user, @Valid @RequestBody PmsTargetsRequest request) {
        PmsTargetValidationResponse result = service.validate(user, request);
        return ResponseEntity.ok(ApiResponse.ok(result, result.valid() ? "Validation passed"
                : "Validation failed"));
    }
}
