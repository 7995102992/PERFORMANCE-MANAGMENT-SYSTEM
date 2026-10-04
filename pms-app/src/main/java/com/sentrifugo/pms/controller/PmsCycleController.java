package com.sentrifugo.pms.controller;

import com.sentrifugo.common.web.ApiResponse;
import com.sentrifugo.pms.model.PmsCycleActivationResponse;
import com.sentrifugo.pms.model.PmsCycleListResponse;
import com.sentrifugo.pms.model.PmsCycleRequest;
import com.sentrifugo.pms.model.PmsCycleResponse;
import com.sentrifugo.pms.service.PmsCycleService;
import com.sentrifugo.pms.utils.PmsCycleCsvExporter;
import com.sentrifugo.pms.utils.PmsPrincipals;
import com.sentrifugo.security.access.RequirePermission;
import com.sentrifugo.security.context.PmsUserPrincipal;
import io.swagger.v3.oas.annotations.Operation;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
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

import java.util.UUID;

/** PMS Cycle APIs (screens 1.1-1.6). */
@RestController
@RequestMapping("${pms.api.base.path}/pms-cycle")
@RequiredArgsConstructor
public class PmsCycleController {

    private static final Logger log = LoggerFactory.getLogger(PmsCycleController.class);

    private final PmsCycleService pmsCycleService;
    private final PmsCycleCsvExporter csvExporter;

    @GetMapping("/get/cycles")
    @Operation(summary = "List PMS cycles (screen 1.1)",
            description = "Retrieves a page of the organisation's appraisal cycles, filtered by search text "
                    + "(cycle code or name), financial year, type, plant and status, with status summary counts. "
                    + "The summary ignores the status filter; total and items honour it. skip must be a multiple "
                    + "of limit.")
    public ResponseEntity<ApiResponse<PmsCycleListResponse>> getCycles(
            @AuthenticationPrincipal PmsUserPrincipal user,
            @RequestParam(required = false) String search,
            @RequestParam(required = false) Integer year,
            @RequestParam(required = false) String type,
            @RequestParam(name = "plant_id", required = false) UUID plantId,
            @RequestParam(required = false) String status,
            @RequestParam(defaultValue = "0") int skip,
            @RequestParam(defaultValue = "20") int limit) {
        log.info("Fetching PMS cycles");
        PmsCycleListResponse cycles = pmsCycleService.getCycles(PmsPrincipals.organisationId(user), search, year,
                type, plantId, status, skip, limit);
        return ResponseEntity.ok(ApiResponse.ok(cycles, String.format("Found %d PMS cycles", cycles.total())));
    }

    /** File download: returns raw CSV bytes, since an ApiResponse envelope cannot carry a file body. */
    @GetMapping("/get/cycles/export")
    @Operation(summary = "Export PMS cycles as CSV (screen 1.1 Export Data)",
            description = "Downloads the organisation's appraisal cycles matching the given filters as pms-cycles.csv.")
    public ResponseEntity<byte[]> exportCycles(
            @AuthenticationPrincipal PmsUserPrincipal user,
            @RequestParam(required = false) String search,
            @RequestParam(required = false) Integer year,
            @RequestParam(required = false) String type,
            @RequestParam(name = "plant_id", required = false) UUID plantId,
            @RequestParam(required = false) String status) {
        log.info("Exporting PMS cycles");
        byte[] csv = csvExporter.toCsv(pmsCycleService.getCyclesForExport(PmsPrincipals.organisationId(user),
                search, year, type, plantId, status));
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.parseMediaType("text/csv"));
        headers.setContentDisposition(ContentDisposition.attachment().filename("pms-cycles.csv").build());
        return new ResponseEntity<>(csv, headers, HttpStatus.OK);
    }

    @GetMapping("/get/cycle/{cycleId}")
    @Operation(summary = "Get a PMS cycle (screens 1.2-1.5 when editing / viewing)",
            description = "Retrieves one appraisal cycle of the authenticated organisation with its basic details, "
                    + "stages, applicability, finalize settings and wizard progress.")
    public ResponseEntity<ApiResponse<PmsCycleResponse>> getCycle(@AuthenticationPrincipal PmsUserPrincipal user,
                                                                  @PathVariable UUID cycleId) {
        log.info("Fetching PMS cycle: {}", cycleId);
        PmsCycleResponse cycle = pmsCycleService.getCycle(PmsPrincipals.organisationId(user), cycleId);
        return ResponseEntity.ok(ApiResponse.ok(cycle, "PMS cycle retrieved successfully"));
    }

    @PostMapping("/create/cycle")
    @RequirePermission(module = "performance_management", action = "create_resource")
    @Operation(summary = "Create a PMS cycle (screen 1.2 Next)",
            description = "Creates a DRAFT appraisal cycle with a server-generated cycle code "
                    + "(PMS-{FYstart yy}{FYend yy}-{A|M|C}). stages, applicability and finalize are optional and "
                    + "are only checked for completeness when the cycle is published.")
    public ResponseEntity<ApiResponse<PmsCycleResponse>> createCycle(
            @AuthenticationPrincipal PmsUserPrincipal user, @Valid @RequestBody PmsCycleRequest request) {
        log.info("Creating PMS cycle");
        PmsCycleResponse cycle = pmsCycleService.createCycle(PmsPrincipals.organisationId(user), request);
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(ApiResponse.ok(cycle, "PMS cycle created successfully"));
    }

    @PutMapping("/update/cycle/{cycleId}")
    @RequirePermission(module = "performance_management", action = "create_resource")
    @Operation(summary = "Update a PMS cycle (screens 1.2-1.5 Next / Previous)",
            description = "Saves the basic details and any supplied stages (1.3), applicability (1.4) and finalize "
                    + "settings (1.5) of a DRAFT or ACTIVE cycle; a supplied list replaces the stored one, an "
                    + "omitted one is unchanged. CLOSED and CANCELLED cycles return 409 PMS_CYCLE_NOT_EDITABLE.")
    public ResponseEntity<ApiResponse<PmsCycleResponse>> updateCycle(
            @AuthenticationPrincipal PmsUserPrincipal user, @PathVariable UUID cycleId,
            @Valid @RequestBody PmsCycleRequest request) {
        log.info("Updating PMS cycle: {}", cycleId);
        PmsCycleResponse cycle = pmsCycleService.updateCycle(PmsPrincipals.organisationId(user), cycleId, request);
        return ResponseEntity.ok(ApiResponse.ok(cycle, "PMS cycle updated successfully"));
    }

    @PostMapping("/publish/cycle/{cycleId}")
    @RequirePermission(module = "performance_management", action = "create_resource")
    @Operation(summary = "Publish a PMS cycle (screen 1.5 Publish Cycle)",
            description = "Moves a complete DRAFT cycle to ACTIVE and stamps the publish time. Requires an active "
                    + "rating scale, plants, employment types, departments (unless all), minimum service, the "
                    + "as-on date and dates for all nine stages. Eligibility processing and notifications are not "
                    + "implemented yet.")
    public ResponseEntity<ApiResponse<PmsCycleActivationResponse>> publishCycle(
            @AuthenticationPrincipal PmsUserPrincipal user, @PathVariable UUID cycleId) {
        log.info("Publishing PMS cycle: {}", cycleId);
        PmsCycleActivationResponse activation =
                pmsCycleService.publishCycle(PmsPrincipals.organisationId(user), cycleId);
        return ResponseEntity.ok(ApiResponse.ok(activation, "PMS cycle published successfully"));
    }

    @GetMapping("/get/cycle/{cycleId}/activation")
    @Operation(summary = "Get PMS cycle activation (screen 1.6)",
            description = "Retrieves the published cycle, its publish date and any recorded notifications and "
                    + "eligibility run. A DRAFT cycle returns 409 PMS_CYCLE_NOT_PUBLISHED.")
    public ResponseEntity<ApiResponse<PmsCycleActivationResponse>> getActivation(
            @AuthenticationPrincipal PmsUserPrincipal user, @PathVariable UUID cycleId) {
        log.info("Fetching activation for PMS cycle: {}", cycleId);
        PmsCycleActivationResponse activation =
                pmsCycleService.getActivation(PmsPrincipals.organisationId(user), cycleId);
        return ResponseEntity.ok(ApiResponse.ok(activation, "PMS cycle activation retrieved successfully"));
    }

    @PostMapping("/cancel/cycle/{cycleId}")
    @RequirePermission(module = "performance_management", action = "create_resource")
    @Operation(summary = "Cancel a PMS cycle",
            description = "Cancels a DRAFT or ACTIVE cycle. CLOSED and CANCELLED cycles return "
                    + "409 PMS_CYCLE_NOT_CANCELLABLE.")
    public ResponseEntity<ApiResponse<PmsCycleResponse>> cancelCycle(
            @AuthenticationPrincipal PmsUserPrincipal user, @PathVariable UUID cycleId) {
        log.info("Cancelling PMS cycle: {}", cycleId);
        PmsCycleResponse cycle = pmsCycleService.cancelCycle(PmsPrincipals.organisationId(user), cycleId);
        return ResponseEntity.ok(ApiResponse.ok(cycle, "PMS cycle cancelled successfully"));
    }
}
