package com.sentrifugo.pms.model;

import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotNull;

import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

/**
 * Screen 2.3 (KRA and KPI Configuration): the selected KRAs and, under each, the selected KPIs with their weight
 * and target type. A KRA / KPI the user left unticked is simply not sent. {@code save_as_draft = true} is the
 * "Save as Draft" button (incomplete selections allowed); otherwise "Save and Next" requires a complete selection.
 */
public record PmsGoalTemplateKraKpiRequest(
        @JsonProperty("save_as_draft") Boolean saveAsDraft,
        @JsonProperty("kras") @NotNull List<@Valid Kra> kras) {

    public record Kra(
            @JsonProperty("kra_id") @NotNull UUID kraId,
            @JsonProperty("kpis") @NotNull List<@Valid Kpi> kpis) {
    }

    /** {@code target_type} ({@code common | individual}) defaults to the KPI master's value. */
    public record Kpi(
            @JsonProperty("kpi_id") @NotNull UUID kpiId,
            @JsonProperty("weightage") @NotNull @DecimalMin(value = "0.00", inclusive = false)
            @DecimalMax("100.00") BigDecimal weightage,
            @JsonProperty("target_type") String targetType) {
    }
}
