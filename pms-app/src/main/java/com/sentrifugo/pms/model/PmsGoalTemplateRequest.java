package com.sentrifugo.pms.model;

import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.time.LocalDate;
import java.util.UUID;

/**
 * Screen 2.2 (Basic Info). {@code department_id}, {@code role_id} and {@code plant_id} are Sentrifugo ids.
 * {@code status} is {@code draft | active | inactive}.
 */
public record PmsGoalTemplateRequest(
        @JsonProperty("financial_year") @NotBlank @Size(max = 20) String financialYear,
        @JsonProperty("template_name") @NotBlank @Size(max = 200) String templateName,
        @JsonProperty("description") @Size(max = 2000) String description,
        @JsonProperty("department_id") @NotNull UUID departmentId,
        @JsonProperty("role_id") @NotNull UUID roleId,
        @JsonProperty("plant_id") UUID plantId,
        @JsonProperty("effective_from") @NotNull LocalDate effectiveFrom,
        @JsonProperty("status") String status) {
}
