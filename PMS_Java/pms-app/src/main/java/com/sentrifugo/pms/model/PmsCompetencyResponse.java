package com.sentrifugo.pms.model;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.UUID;

public record PmsCompetencyResponse(
        @JsonProperty("id") UUID id,
        @JsonProperty("name") String name,
        @JsonProperty("category") String category,
        @JsonProperty("status") String status) {
}
