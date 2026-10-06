package com.sentrifugo.pms.model;

import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** Add / edit a competency (screen 2.9). {@code status} is {@code active | inactive}, default active. */
public record PmsCompetencyRequest(
        @JsonProperty("name") @NotBlank @Size(max = 200) String name,
        @JsonProperty("category") @NotBlank @Size(max = 100) String category,
        @JsonProperty("status") String status) {
}
