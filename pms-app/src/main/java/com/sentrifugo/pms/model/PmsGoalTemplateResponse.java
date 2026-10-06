package com.sentrifugo.pms.model;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * A goal template with its KRA / KPI and competency selections (screens 2.2-2.4). Department, role and plant are
 * Sentrifugo ids; their names are not stored in PMS. KPI expected outcome and evidence are the KPI master's values:
 * the template schema has nowhere to keep a per-template override.
 */
public record PmsGoalTemplateResponse(
        @JsonProperty("id") UUID id,
        @JsonProperty("financial_year") String financialYear,
        @JsonProperty("template_name") String templateName,
        @JsonProperty("description") String description,
        @JsonProperty("department_id") String departmentId,
        @JsonProperty("role_id") String roleId,
        @JsonProperty("plant_id") String plantId,
        @JsonProperty("effective_from") LocalDate effectiveFrom,
        @JsonProperty("status") String status,
        @JsonProperty("kras") List<Kra> kras,
        @JsonProperty("competencies") List<Competency> competencies,
        @JsonProperty("total_kpi_weightage") BigDecimal totalKpiWeightage,
        @JsonProperty("total_competency_weightage") BigDecimal totalCompetencyWeightage) {

    public record Kra(
            @JsonProperty("kra_id") UUID kraId,
            @JsonProperty("kra_name") String kraName,
            @JsonProperty("kpis") List<Kpi> kpis) {
    }

    public record Kpi(
            @JsonProperty("kpi_id") UUID kpiId,
            @JsonProperty("kpi_name") String kpiName,
            @JsonProperty("unit") String unit,
            @JsonProperty("weightage") BigDecimal weightage,
            @JsonProperty("target_type") String targetType,
            @JsonProperty("expected_outcome") String expectedOutcome,
            @JsonProperty("evidence_required") String evidenceRequired) {
    }

    public record Competency(
            @JsonProperty("competency_id") UUID competencyId,
            @JsonProperty("name") String name,
            @JsonProperty("category") String category,
            @JsonProperty("weightage") BigDecimal weightage) {
    }
}
