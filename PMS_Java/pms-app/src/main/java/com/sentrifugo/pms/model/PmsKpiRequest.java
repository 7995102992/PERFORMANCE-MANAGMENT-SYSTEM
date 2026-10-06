package com.sentrifugo.pms.model;

import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.util.UUID;

/** Add / edit a KPI (screens 2.7, 2.8). {@code target_type} is {@code individual | common}. */
public record PmsKpiRequest(
        @JsonProperty("kra_id") @NotNull UUID kraId,
        @JsonProperty("name") @NotBlank @Size(max = 200) String name,
        @JsonProperty("unit") @NotBlank @Size(max = 50) String unit,
        @JsonProperty("target_type") @NotBlank String targetType,
        @JsonProperty("expected_outcome") @Size(max = 500) String expectedOutcome,
        @JsonProperty("evidence_required") @Size(max = 500) String evidenceRequired,
        @JsonProperty("status") String status) {
}
