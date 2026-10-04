package com.sentrifugo.pms.controller;

import com.sentrifugo.common.web.ApiResponse;
import com.sentrifugo.pms.model.PmsCompetencyRequest;
import com.sentrifugo.pms.model.PmsCompetencyResponse;
import com.sentrifugo.pms.model.PmsKpiRequest;
import com.sentrifugo.pms.model.PmsKpiResponse;
import com.sentrifugo.pms.model.PmsKraRequest;
import com.sentrifugo.pms.model.PmsKraResponse;
import com.sentrifugo.pms.service.PmsMasterService;
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
import org.springframework.web.bind.annotation.DeleteMapping;
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

/** Master-data APIs: KRA (screens 2.5, 2.6), KPI (2.7, 2.8) and competency (2.9). */
@RestController
@RequestMapping("${pms.api.base.path}/pms-master")
@RequiredArgsConstructor
public class PmsMasterController {

    private static final Logger log = LoggerFactory.getLogger(PmsMasterController.class);

    private final PmsMasterService service;

    // ── KRA ──────────────────────────────────────────────────────────────────

    @GetMapping("/get/kras")
    @Operation(summary = "List KRAs (screen 2.5, KRA dropdowns)",
            description = "Retrieves the organisation's Key Result Areas, oldest first.")
    public ResponseEntity<ApiResponse<List<PmsKraResponse>>> getKras(@AuthenticationPrincipal PmsUserPrincipal user) {
        log.info("Fetching KRAs");
        List<PmsKraResponse> kras = service.getKras(PmsPrincipals.organisationId(user));
        return ResponseEntity.ok(ApiResponse.ok(kras, String.format("Found %d KRAs", kras.size())));
    }

    @PostMapping("/create/kra")
    @RequirePermission(module = "performance_management", action = "create_resource")
    @Operation(summary = "Add a KRA (screen 2.6)",
            description = "Adds a Key Result Area; names are unique per organisation (case-insensitive).")
    public ResponseEntity<ApiResponse<PmsKraResponse>> createKra(@AuthenticationPrincipal PmsUserPrincipal user,
                                                                 @Valid @RequestBody PmsKraRequest request) {
        log.info("Creating KRA");
        PmsKraResponse kra = service.createKra(PmsPrincipals.organisationId(user), request);
        return ResponseEntity.status(HttpStatus.CREATED).body(ApiResponse.ok(kra, "KRA created successfully"));
    }

    @PutMapping("/update/kra/{kraId}")
    @RequirePermission(module = "performance_management", action = "create_resource")
    @Operation(summary = "Edit a KRA (screen 2.5 edit action)",
            description = "Renames a KRA and/or changes its status.")
    public ResponseEntity<ApiResponse<PmsKraResponse>> updateKra(@AuthenticationPrincipal PmsUserPrincipal user,
                                                                 @PathVariable UUID kraId,
                                                                 @Valid @RequestBody PmsKraRequest request) {
        log.info("Updating KRA: {}", kraId);
        PmsKraResponse kra = service.updateKra(PmsPrincipals.organisationId(user), kraId, request);
        return ResponseEntity.ok(ApiResponse.ok(kra, "KRA updated successfully"));
    }

    @DeleteMapping("/delete/kra/{kraId}")
    @RequirePermission(module = "performance_management", action = "create_resource")
    @Operation(summary = "Delete a KRA (screen 2.5 delete action)",
            description = "Removes a KRA from the master list; rejected while KPIs exist under it or a goal "
                    + "template uses it (409 PMS_KRA_IN_USE).")
    public ResponseEntity<ApiResponse<Void>> deleteKra(@AuthenticationPrincipal PmsUserPrincipal user,
                                                       @PathVariable UUID kraId) {
        log.info("Deleting KRA: {}", kraId);
        service.deleteKra(PmsPrincipals.organisationId(user), kraId);
        return ResponseEntity.ok(ApiResponse.ok("KRA deleted successfully"));
    }

    // ── KPI ──────────────────────────────────────────────────────────────────

    @GetMapping("/get/kpis")
    @Operation(summary = "List KPIs (screen 2.7)",
            description = "Retrieves the organisation's KPIs with their KRA, unit, target type, expected outcome "
                    + "and evidence required.")
    public ResponseEntity<ApiResponse<List<PmsKpiResponse>>> getKpis(@AuthenticationPrincipal PmsUserPrincipal user) {
        log.info("Fetching KPIs");
        List<PmsKpiResponse> kpis = service.getKpis(PmsPrincipals.organisationId(user));
        return ResponseEntity.ok(ApiResponse.ok(kpis, String.format("Found %d KPIs", kpis.size())));
    }

    @GetMapping("/get/kpi-units")
    @Operation(summary = "List KPI units (screen 2.8 Unit dropdown)",
            description = "Retrieves the units offered in the KPI Unit dropdown.")
    public ResponseEntity<ApiResponse<List<String>>> getKpiUnits() {
        List<String> units = service.getKpiUnits();
        return ResponseEntity.ok(ApiResponse.ok(units, String.format("Found %d KPI units", units.size())));
    }

    @PostMapping("/create/kpi")
    @RequirePermission(module = "performance_management", action = "create_resource")
    @Operation(summary = "Add a KPI (screen 2.8)",
            description = "Adds a KPI under an existing KRA of the organisation; names are unique per KRA.")
    public ResponseEntity<ApiResponse<PmsKpiResponse>> createKpi(@AuthenticationPrincipal PmsUserPrincipal user,
                                                                 @Valid @RequestBody PmsKpiRequest request) {
        log.info("Creating KPI");
        PmsKpiResponse kpi = service.createKpi(PmsPrincipals.organisationId(user), request);
        return ResponseEntity.status(HttpStatus.CREATED).body(ApiResponse.ok(kpi, "KPI created successfully"));
    }

    @PutMapping("/update/kpi/{kpiId}")
    @RequirePermission(module = "performance_management", action = "create_resource")
    @Operation(summary = "Edit a KPI (screen 2.7 edit action)",
            description = "Replaces a KPI's KRA, name, unit, target type, expected outcome and evidence required.")
    public ResponseEntity<ApiResponse<PmsKpiResponse>> updateKpi(@AuthenticationPrincipal PmsUserPrincipal user,
                                                                 @PathVariable UUID kpiId,
                                                                 @Valid @RequestBody PmsKpiRequest request) {
        log.info("Updating KPI: {}", kpiId);
        PmsKpiResponse kpi = service.updateKpi(PmsPrincipals.organisationId(user), kpiId, request);
        return ResponseEntity.ok(ApiResponse.ok(kpi, "KPI updated successfully"));
    }

    @DeleteMapping("/delete/kpi/{kpiId}")
    @RequirePermission(module = "performance_management", action = "create_resource")
    @Operation(summary = "Delete a KPI (screen 2.7 delete action)",
            description = "Removes a KPI from the master list; rejected while a goal template uses it "
                    + "(409 PMS_KPI_IN_USE).")
    public ResponseEntity<ApiResponse<Void>> deleteKpi(@AuthenticationPrincipal PmsUserPrincipal user,
                                                       @PathVariable UUID kpiId) {
        log.info("Deleting KPI: {}", kpiId);
        service.deleteKpi(PmsPrincipals.organisationId(user), kpiId);
        return ResponseEntity.ok(ApiResponse.ok("KPI deleted successfully"));
    }

    // ── Competency ───────────────────────────────────────────────────────────

    @GetMapping("/get/competencies")
    @Operation(summary = "List competencies (screen 2.9, competency configuration 2.4)",
            description = "Retrieves the organisation's competencies, optionally narrowed by a name search.")
    public ResponseEntity<ApiResponse<List<PmsCompetencyResponse>>> getCompetencies(
            @AuthenticationPrincipal PmsUserPrincipal user, @RequestParam(required = false) String search) {
        log.info("Fetching competencies");
        List<PmsCompetencyResponse> competencies =
                service.getCompetencies(PmsPrincipals.organisationId(user), search);
        return ResponseEntity.ok(ApiResponse.ok(competencies,
                String.format("Found %d competencies", competencies.size())));
    }

    @PostMapping("/create/competency")
    @RequirePermission(module = "performance_management", action = "create_resource")
    @Operation(summary = "Add a competency",
            description = "Adds a competency; names are unique per organisation. Screen 2.9 has no add button, "
                    + "so this is how competencies get into the system.")
    public ResponseEntity<ApiResponse<PmsCompetencyResponse>> createCompetency(
            @AuthenticationPrincipal PmsUserPrincipal user, @Valid @RequestBody PmsCompetencyRequest request) {
        log.info("Creating competency");
        PmsCompetencyResponse competency = service.createCompetency(PmsPrincipals.organisationId(user), request);
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(ApiResponse.ok(competency, "Competency created successfully"));
    }

    @PutMapping("/update/competency/{competencyId}")
    @RequirePermission(module = "performance_management", action = "create_resource")
    @Operation(summary = "Edit a competency (screen 2.9 edit action)",
            description = "Changes a competency's name, category and/or status.")
    public ResponseEntity<ApiResponse<PmsCompetencyResponse>> updateCompetency(
            @AuthenticationPrincipal PmsUserPrincipal user, @PathVariable UUID competencyId,
            @Valid @RequestBody PmsCompetencyRequest request) {
        log.info("Updating competency: {}", competencyId);
        PmsCompetencyResponse competency =
                service.updateCompetency(PmsPrincipals.organisationId(user), competencyId, request);
        return ResponseEntity.ok(ApiResponse.ok(competency, "Competency updated successfully"));
    }

    @DeleteMapping("/delete/competency/{competencyId}")
    @RequirePermission(module = "performance_management", action = "create_resource")
    @Operation(summary = "Delete a competency (screen 2.9 delete action)",
            description = "Removes a competency from the master list; rejected while a goal template uses it "
                    + "(409 PMS_COMPETENCY_IN_USE).")
    public ResponseEntity<ApiResponse<Void>> deleteCompetency(@AuthenticationPrincipal PmsUserPrincipal user,
                                                              @PathVariable UUID competencyId) {
        log.info("Deleting competency: {}", competencyId);
        service.deleteCompetency(PmsPrincipals.organisationId(user), competencyId);
        return ResponseEntity.ok(ApiResponse.ok("Competency deleted successfully"));
    }
}
