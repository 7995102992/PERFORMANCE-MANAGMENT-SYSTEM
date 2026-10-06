package com.sentrifugo.pms.model;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

/** Screens 3.2 / 3.3: the employee's template KPIs with the manager's weights and targets. */
public record PmsEmployeeTargetsResponse(
        @JsonProperty("employee_user_id") String employeeUserId,
        @JsonProperty("financial_year") String financialYear,
        @JsonProperty("goal_status") String goalStatus,
        @JsonProperty("template_id") UUID templateId,
        @JsonProperty("template_name") String templateName,
        @JsonProperty("kpis") List<Kpi> kpis,
        @JsonProperty("change_kpi_id") UUID changeKpiId,
        @JsonProperty("change_reason") String changeReason,
        @JsonProperty("change_proposed_target") BigDecimal changeProposedTarget,
        @JsonProperty("hod_remarks") String hodRemarks) {

    public record Kpi(
            @JsonProperty("kpi_id") UUID kpiId,
            @JsonProperty("kra_name") String kraName,
            @JsonProperty("kpi_name") String kpiName,
            @JsonProperty("unit") String unit,
            @JsonProperty("expected_outcome") String expectedOutcome,
            @JsonProperty("evidence_required") String evidenceRequired,
            @JsonProperty("weight") BigDecimal weight,
            @JsonProperty("target") BigDecimal target) {
    }
}
