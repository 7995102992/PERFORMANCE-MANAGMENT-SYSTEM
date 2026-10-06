package com.sentrifugo.pms.model;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.time.LocalDate;
import java.util.UUID;

/**
 * One row of the goal template list (screen 2.1). The role, department and plant columns show names in the UI,
 * but PMS only holds their Sentrifugo ids; names have to be resolved from the Sentrifugo system.
 */
public record PmsGoalTemplateListResponse(
        @JsonProperty("id") UUID id,
        @JsonProperty("template_name") String templateName,
        @JsonProperty("financial_year") String financialYear,
        @JsonProperty("department_id") String departmentId,
        @JsonProperty("role_id") String roleId,
        @JsonProperty("plant_id") String plantId,
        @JsonProperty("effective_from") LocalDate effectiveFrom,
        @JsonProperty("status") String status) {
}
