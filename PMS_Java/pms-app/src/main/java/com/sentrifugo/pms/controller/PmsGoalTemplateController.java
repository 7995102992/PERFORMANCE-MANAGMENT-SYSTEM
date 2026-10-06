package com.sentrifugo.pms.controller;

import com.sentrifugo.common.web.ApiResponse;
import com.sentrifugo.pms.model.PmsGoalTemplateCompetencyRequest;
import com.sentrifugo.pms.model.PmsGoalTemplateKraKpiRequest;
import com.sentrifugo.pms.model.PmsGoalTemplateListResponse;
import com.sentrifugo.pms.model.PmsGoalTemplateRequest;
import com.sentrifugo.pms.model.PmsGoalTemplateResponse;
import com.sentrifugo.pms.service.PmsGoalTemplateService;
import com.sentrifugo.pms.utils.PmsPrincipals;
import com.sentrifugo.security.access.RequirePermission;
import com.sentrifugo.security.context.PmsUserPrincipal;
import io.swagger.v3.oas.annotations.Operation;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

/** Goal template APIs (screens 2.1-2.4). */
@RestController
@RequestMapping("${pms.api.base.path}/pms-goal-template")
@RequiredArgsConstructor
public class PmsGoalTemplateController {

    private static final Logger log = LoggerFactory.getLogger(PmsGoalTemplateController.class);

    private final PmsGoalTemplateService service;

    @GetMapping("/get/goal-templates")
    @Operation(summary = "List goal templates (screen 2.1)",
            description = "Retrieves the organisation's goal templates, filtered by financial year, department, "
                    + "plant and a template-name search; every filter is optional.")
    public ResponseEntity<ApiResponse<List<PmsGoalTemplateListResponse>>> getGoalTemplates(
            @AuthenticationPrincipal PmsUserPrincipal user,
            @RequestParam(name = "financial_year", required = false) String financialYear,
            @RequestParam(name = "department_id", required = false) String departmentId,
            @RequestParam(name = "plant_id", required = false) String plantId,
            @RequestParam(required = false) String search) {
        log.info("Fetching goal templates");
        List<PmsGoalTemplateListResponse> templates = service.getGoalTemplates(PmsPrincipals.organisationId(user),
                financialYear, departmentId, plantId, search);
        return ResponseEntity.ok(ApiResponse.ok(templates,
                String.format("Found %d goal templates", templates.size())));
    }

    @GetMapping("/get/goal-template/{templateId}")
    @Operation(summary = "Get a goal template (screens 2.2-2.4 when editing / viewing)",
            description = "Retrieves one goal template with its basic info, KRAs with their KPIs, competencies "
                    + "and weightage totals.")
    public ResponseEntity<ApiResponse<PmsGoalTemplateResponse>> getGoalTemplate(
            @AuthenticationPrincipal PmsUserPrincipal user, @PathVariable UUID templateId) {
        log.info("Fetching goal template: {}", templateId);
        PmsGoalTemplateResponse template =
                service.getGoalTemplate(PmsPrincipals.organisationId(user), templateId);
        return ResponseEntity.ok(ApiResponse.ok(template, "Goal template retrieved successfully"));
    }

    @PostMapping("/create/goal-template")
    @RequirePermission(module = "performance_management", action = "manage_goal_templates")
    @Operation(summary = "Create a goal template (screen 2.2 Save and Next)",
            description = "Saves the template's basic info. The template starts as a draft and becomes active "
                    + "once its KRA/KPI and competency steps are saved complete; status=inactive is kept.")
    public ResponseEntity<ApiResponse<PmsGoalTemplateResponse>> createGoalTemplate(
            @AuthenticationPrincipal PmsUserPrincipal user, @Valid @RequestBody PmsGoalTemplateRequest request) {
        log.info("Creating goal template");
        PmsGoalTemplateResponse template =
                service.createGoalTemplate(PmsPrincipals.organisationId(user), request);
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(ApiResponse.ok(template, "Goal template created successfully"));
    }

    @PutMapping("/update/goal-template/{templateId}")
    @RequirePermission(module = "performance_management", action = "manage_goal_templates")
    @Operation(summary = "Update goal template basic info (screen 2.2)",
            description = "Replaces the template's financial year, name, description, department, role, plant, "
                    + "effective date and status. Marking it active only sticks while the template is complete.")
    public ResponseEntity<ApiResponse<PmsGoalTemplateResponse>> updateGoalTemplate(
            @AuthenticationPrincipal PmsUserPrincipal user, @PathVariable UUID templateId,
            @Valid @RequestBody PmsGoalTemplateRequest request) {
        log.info("Updating goal template: {}", templateId);
        PmsGoalTemplateResponse template =
                service.updateGoalTemplate(PmsPrincipals.organisationId(user), templateId, request);
        return ResponseEntity.ok(ApiResponse.ok(template, "Goal template updated successfully"));
    }

    @PutMapping("/update/goal-template/{templateId}/kra-kpi")
    @RequirePermission(module = "performance_management", action = "manage_goal_templates")
    @Operation(summary = "Save KRA and KPI configuration (screen 2.3 Save as Draft / Save and Next)",
            description = "Replaces the template's selected KRAs and KPIs with their weightage and target type, in "
                    + "one transaction. Each KPI must belong to its KRA. Unless save_as_draft is true, every KRA "
                    + "needs a KPI and the KPI weightages must total 100.")
    public ResponseEntity<ApiResponse<PmsGoalTemplateResponse>> saveKraKpi(
            @AuthenticationPrincipal PmsUserPrincipal user, @PathVariable UUID templateId,
            @Valid @RequestBody PmsGoalTemplateKraKpiRequest request) {
        log.info("Saving KRA/KPI configuration of goal template: {}", templateId);
        PmsGoalTemplateResponse template =
                service.saveKraKpi(PmsPrincipals.organisationId(user), templateId, request);
        return ResponseEntity.ok(ApiResponse.ok(template, "KRA and KPI configuration saved successfully"));
    }

    @PutMapping("/update/goal-template/{templateId}/competencies")
    @RequirePermission(module = "performance_management", action = "manage_goal_templates")
    @Operation(summary = "Save competency configuration (screen 2.4 Save)",
            description = "Replaces the template's competencies and weightages, which must total 100, in one "
                    + "transaction. A complete draft template becomes active.")
    public ResponseEntity<ApiResponse<PmsGoalTemplateResponse>> saveCompetencies(
            @AuthenticationPrincipal PmsUserPrincipal user, @PathVariable UUID templateId,
            @Valid @RequestBody PmsGoalTemplateCompetencyRequest request) {
        log.info("Saving competencies of goal template: {}", templateId);
        PmsGoalTemplateResponse template =
                service.saveCompetencies(PmsPrincipals.organisationId(user), templateId, request);
        return ResponseEntity.ok(ApiResponse.ok(template, "Competency configuration saved successfully"));
    }
}
