package com.sentrifugo.pms.controller;

import com.sentrifugo.common.web.ApiResponse;
import com.sentrifugo.pms.model.PmsRatingScaleRequest;
import com.sentrifugo.pms.model.PmsRatingScaleResponse;
import com.sentrifugo.pms.service.PmsRatingScaleService;
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

/** Rating scale APIs (screens 1.5 dropdown and 2.10). */
@RestController
@RequestMapping("${pms.api.base.path}/pms-rating-scale")
@RequiredArgsConstructor
public class PmsRatingScaleController {

    private static final Logger log = LoggerFactory.getLogger(PmsRatingScaleController.class);

    private final PmsRatingScaleService service;

    @GetMapping("/get/rating-scales")
    @Operation(summary = "List rating scales (screen 1.5 dropdown, screen 2.10)",
            description = "Retrieves the organisation's rating scales with their levels (highest rating first). "
                    + "Pass status=active to populate the cycle wizard dropdown.")
    public ResponseEntity<ApiResponse<List<PmsRatingScaleResponse>>> getRatingScales(
            @AuthenticationPrincipal PmsUserPrincipal user, @RequestParam(required = false) String status) {
        log.info("Fetching rating scales");
        List<PmsRatingScaleResponse> scales = service.getRatingScales(PmsPrincipals.organisationId(user), status);
        return ResponseEntity.ok(ApiResponse.ok(scales, String.format("Found %d rating scales", scales.size())));
    }

    @GetMapping("/get/rating-scale/{scaleId}")
    @Operation(summary = "Get a rating scale (screen 2.10)",
            description = "Retrieves one rating scale of the authenticated organisation with its levels.")
    public ResponseEntity<ApiResponse<PmsRatingScaleResponse>> getRatingScale(
            @AuthenticationPrincipal PmsUserPrincipal user, @PathVariable UUID scaleId) {
        log.info("Fetching rating scale: {}", scaleId);
        PmsRatingScaleResponse scale = service.getRatingScale(PmsPrincipals.organisationId(user), scaleId);
        return ResponseEntity.ok(ApiResponse.ok(scale, "Rating scale retrieved successfully"));
    }

    @PostMapping("/create/rating-scale")
    @RequirePermission(module = "performance_management", action = "create_resource")
    @Operation(summary = "Create a rating scale",
            description = "Creates a rating scale with its levels. Screen 2.10 only edits an existing scale, so "
                    + "this is how the first scale gets into the system.")
    public ResponseEntity<ApiResponse<PmsRatingScaleResponse>> createRatingScale(
            @AuthenticationPrincipal PmsUserPrincipal user, @Valid @RequestBody PmsRatingScaleRequest request) {
        log.info("Creating rating scale");
        PmsRatingScaleResponse scale = service.createRatingScale(PmsPrincipals.organisationId(user), request);
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(ApiResponse.ok(scale, "Rating scale created successfully"));
    }

    @PutMapping("/update/rating-scale/{scaleId}")
    @RequirePermission(module = "performance_management", action = "create_resource")
    @Operation(summary = "Save a rating scale (screen 2.10 Save Scale)",
            description = "Replaces the scale's name, status, default and show-definitions flags and syncs its "
                    + "levels by rating value. Setting is_default clears the default on the organisation's other "
                    + "scales. Level score ranges must not overlap.")
    public ResponseEntity<ApiResponse<PmsRatingScaleResponse>> updateRatingScale(
            @AuthenticationPrincipal PmsUserPrincipal user, @PathVariable UUID scaleId,
            @Valid @RequestBody PmsRatingScaleRequest request) {
        log.info("Updating rating scale: {}", scaleId);
        PmsRatingScaleResponse scale =
                service.updateRatingScale(PmsPrincipals.organisationId(user), scaleId, request);
        return ResponseEntity.ok(ApiResponse.ok(scale, "Rating scale updated successfully"));
    }
}
