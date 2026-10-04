package com.sentrifugo.pms.model;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.UUID;

public record PmsKpiResponse(
        @JsonProperty("id") UUID id,
        @JsonProperty("kra_id") UUID kraId,
        @JsonProperty("kra_name") String kraName,
        @JsonProperty("name") String name,
        @JsonProperty("unit") String unit,
        @JsonProperty("target_type") String targetType,
        @JsonProperty("expected_outcome") String expectedOutcome,
        @JsonProperty("evidence_required") String evidenceRequired,
        @JsonProperty("status") String status) {
}
